/**
 * pi-ai-backed implementation of the Harness LLM seam for Bedrock Mantle.
 *
 * The adapter holds one immutable `Models` collection built from the two
 * resolved routes, and signs every request with a single per-adapter SigV4
 * `fetch` passed as a `streamSimple` option. There is no per-request
 * credential resolution: SigV4 draws short-lived credentials from the ambient
 * AWS chain inside that `fetch`, and the placeholder api-key only lets pi-ai's
 * SDK client construct.
 *
 * @module @deepseek-ai/dsh-llm-mantle/adapter
 */

import { createModels } from '@earendil-works/pi-ai'
import type { Api, Model, Models } from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedMantleConfig } from './config.ts'
import { toPiContext } from './context.ts'
import { buildProvider, MANTLE_SERVICE } from './provider.ts'
import type { RouteSpec } from './provider.ts'
import { createSigV4Fetch } from './sigv4.ts'
import { toStreamChunks } from './stream.ts'

/** Merge attribution over deployment headers, attribution winning collisions. */
function requestHeaders(): Record<string, string> {
  return { ...attributionHeaders() }
}

/**
 * Multi-route Mantle adapter. Both routes share one SigV4 signer and one
 * immutable `Models` collection, so every stream call reaches the gateway with
 * a freshly signed `Authorization` header and no bearer credential.
 */
export class MantleAdapter extends LlmAdapter {
  private readonly routes: ReadonlyMap<string, RouteSpec>
  private readonly models: Models
  private readonly signedFetch: typeof globalThis.fetch
  private readonly retryPolicy: ResolvedRetryPolicy
  private readonly streamIdleTimeoutMs: number

  constructor(config: ResolvedMantleConfig) {
    super()
    this.routes = new Map(config.routes.map(route => [route.provider, route]))
    this.retryPolicy = config.retryPolicy
    this.streamIdleTimeoutMs = config.streamIdleTimeoutMs
    this.signedFetch = createSigV4Fetch({ service: MANTLE_SERVICE, region: config.region })
    const models = createModels()
    for (const route of config.routes) models.setProvider(buildProvider(route))
    this.models = models
  }

  /** The route spec for one provider key, or the not-owned failure. */
  private routeOf(provider: string): RouteSpec {
    const route = this.routes.get(provider)
    if (route === undefined) {
      throw new LlmError(`mantle adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return route
  }

  /** The single pi-ai model descriptor for one route, or the unknown-model failure. */
  private modelOf(route: RouteSpec, model: string): Model<Api> {
    const resolved = this.models.getModel(route.provider, model)
    if (resolved === undefined) {
      throw new LlmError(`mantle provider "${route.provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.routeOf(provider).displayName }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const route = this.routeOf(provider)
      return this.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: route.displayName,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => this.modelInfo(provider, model))
  }

  private modelInfo(provider: string, model: string): LlmResolvedModelInfo {
    const route = this.routeOf(provider)
    const resolved = this.modelOf(route, model)
    return {
      provider,
      id: model,
      name: route.displayName,
      inputModalities: [...resolved.input],
      context: { contextWindow: resolved.contextWindow },
      defaultMaxTokens: route.maxTokens,
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return Promise.resolve({
      model: this.modelInfo(provider, model),
      stream: (options: GenerateOptions) => this.stream(options),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamRoute(options)
  }

  private async * streamRoute(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-mantle does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const route = this.routeOf(options.provider)
    const model = this.modelOf(route, options.model)
    if (options.messages.some(message => contentHasImage(message.content))) {
      throw new LlmError('llm-mantle does not support image input', 'UNSUPPORTED_CONTENT')
    }

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = this.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const context = toPiContext(options)
      const events = this.models.streamSimple(model, context, {
        fetch: this.signedFetch,
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        headers: requestHeaders(),
        // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
        maxRetries: 0,
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          /* v8 ignore next -- covers a read resolving in the same tick the deadline fired; the abort path is the tested one */
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('mantle stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`mantle stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('mantle request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('mantle stream consumer stopped')
    }
  }
}
