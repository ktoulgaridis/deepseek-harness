/**
 * Plugin configuration for the Bedrock Mantle adapter and its resolution into
 * the two fixed provider routes.
 *
 * @module @deepseek-ai/dsh-llm-mantle/config
 */

import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { MantleApi, RouteSpec } from './provider.ts'

/** Default AWS region signed into the SigV4 credential scope and endpoint host. */
export const DEFAULT_REGION = 'us-east-1'
/** Default per-request output-token cap when a request names none. */
export const DEFAULT_MAX_TOKENS = 8_192
/** Default advertised context capacity for both routes. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default maximum provider idle time while one stream read is outstanding (five minutes). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * One route's fixed identity. The model ids and wire protocols are the Mantle
 * gateway's own catalog — an external spec, not a deployment choice — so they
 * are constants; `basePath` is the gateway's per-protocol path suffix appended
 * to the regional host.
 */
interface RouteTemplate {
  provider: string
  displayName: string
  api: MantleApi
  model: string
  basePath: string
}

/** The two routes this adapter serves, most-reached first. */
export const ROUTE_TEMPLATES: readonly RouteTemplate[] = [
  {
    provider: 'mantle-claude',
    displayName: 'Mantle Claude',
    api: 'anthropic-messages',
    model: 'anthropic.claude-opus-4-8',
    basePath: '/anthropic',
  },
  {
    provider: 'mantle-gpt',
    displayName: 'Mantle GPT',
    api: 'openai-responses',
    model: 'openai.gpt-5.6-sol',
    basePath: '/openai/v1',
  },
]

/**
 * Plugin config, validated by the same-named schemastery schema. Every field
 * is optional in yml: the region defaults to {@link DEFAULT_REGION}, and the
 * request caps and stream timeout take their documented defaults. Credentials
 * are never configured — the adapter signs with the ambient AWS chain.
 */
export interface Config {
  /** AWS region for the SigV4 scope and the `bedrock-mantle.{region}.api.aws` host (default `us-east-1`). */
  region?: string
  /** Default per-request output-token cap; an explicit request value wins (default 8,192). */
  maxTokens?: number
  /** Advertised context capacity for both routes (default 200,000). */
  contextWindow?: number
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with its default retries. */
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  region: z.string().default(DEFAULT_REGION),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  contextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** The fully-resolved facts one operation reads: the routes plus shared knobs. */
export interface ResolvedMantleConfig {
  /** AWS region signed into every request's credential scope. */
  region: string
  /** The two resolved provider routes, in {@link ROUTE_TEMPLATES} order. */
  routes: RouteSpec[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned retry policy captured at registration. */
  retryPolicy: ResolvedRetryPolicy
}

/**
 * The one explicit resolve step from raw config to validated route facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here.
 * @param config - raw plugin config.
 * @returns the resolved region, route specs, timeout, and retry policy.
 * @throws Error when a numeric field is out of range.
 */
export function resolveConfig(config: Config): ResolvedMantleConfig {
  const region = config.region ?? DEFAULT_REGION
  if (region.length === 0) throw new Error('llm-mantle: region must be a non-empty string')
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-mantle: maxTokens must be a positive safe integer')
  }
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error('llm-mantle: contextWindow must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-mantle: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const routes = ROUTE_TEMPLATES.map((template): RouteSpec => ({
    provider: template.provider,
    displayName: template.displayName,
    api: template.api,
    baseURL: `https://${MANTLE_HOST_PREFIX}.${region}.api.aws${template.basePath}`,
    model: template.model,
    contextWindow,
    maxTokens,
  }))
  return {
    region,
    routes,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-mantle: retryPolicy'),
  }
}

/** The regional Bedrock Mantle host prefix; the region and `.api.aws` complete it. */
const MANTLE_HOST_PREFIX = 'bedrock-mantle'
