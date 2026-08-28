/**
 * Adapter behavior: route/model metadata, ownership and unknown-model failures,
 * the request options handed to pi-ai (signed fetch + attribution headers), and
 * the stop/image/abort/timeout guards on the stream path. pi-ai's `Models` is
 * mocked here (the external library boundary); the live both-shape completion is
 * proven through the real Loader separately.
 */

import { describe, expect, it } from 'vitest'
import type { Api, AssistantMessageEvent, Model, Models } from '@earendil-works/pi-ai'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { MantleAdapter } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'

function adapter(): MantleAdapter {
  return new MantleAdapter(resolveConfig({ region: 'us-east-1' }))
}

const model = (over: Partial<Model<Api>> = {}): Model<Api> => ({
  id: 'anthropic.claude-opus-4-8', name: 'Mantle Claude', api: 'anthropic-messages', provider: 'mantle-claude',
  baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/anthropic', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192, ...over,
}) as Model<Api>

const user = (text: string): Message => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

function request(over: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'mantle-claude', model: 'anthropic.claude-opus-4-8', messages: [user('hi')], ...over } as GenerateOptions
}

async function drain(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

describe('MantleAdapter metadata', () => {
  it('reports provider info, retry policy, models, and exact model info', async () => {
    const a = adapter()
    expect(a.providerInfo('mantle-claude')).toEqual({ id: 'mantle-claude', name: 'Mantle Claude' })
    expect(a.providerRetryPolicy('mantle-gpt')).toBeDefined()
    expect(await a.listModels('mantle-gpt')).toEqual([
      { provider: 'mantle-gpt', id: 'openai.gpt-5.6-sol', name: 'Mantle GPT', inputModalities: ['text'] },
    ])
    const info = await a.resolveModel('mantle-claude', 'anthropic.claude-opus-4-8')
    expect(info).toMatchObject({ provider: 'mantle-claude', id: 'anthropic.claude-opus-4-8', name: 'Mantle Claude', context: { contextWindow: 200_000 }, defaultMaxTokens: 8_192 })
    const prepared = await a.prepareCall('mantle-claude', 'anthropic.claude-opus-4-8')
    expect(prepared.model.id).toBe('anthropic.claude-opus-4-8')
  })

  it('fails on an unowned provider and an unknown model', async () => {
    const a = adapter()
    await expect(a.listModels('nope')).rejects.toThrow(/does not own provider "nope"/)
    await expect(a.resolveModel('mantle-claude', 'ghost')).rejects.toThrow(/has no configured model "ghost"/)
  })
})

describe('MantleAdapter.stream', () => {
  function withMockModels(a: MantleAdapter, streamSimple: Models['streamSimple']): { opts: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {}
    const fake = {
      getModel: () => model(),
      streamSimple: (m: Model<Api>, ctx: unknown, options?: Record<string, unknown>) => {
        captured = options ?? {}
        return streamSimple(m, ctx as never, options as never)
      },
    }
    ;(a as unknown as { models: Models }).models = fake as unknown as Models
    return { opts: () => captured }
  }

  it('streams a completion, passing the signed fetch and attribution headers to pi-ai', async () => {
    const a = adapter()
    async function* events(): AsyncGenerator<AssistantMessageEvent> {
      yield { type: 'done', message: model() && {
        role: 'assistant', content: [{ type: 'text', text: 'pong' }], api: 'anthropic-messages',
        provider: 'mantle-claude', model: 'anthropic.claude-opus-4-8', stopReason: 'stop', timestamp: 0,
        usage: {
          input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } } as unknown as AssistantMessageEvent
    }
    const probe = withMockModels(a, (() => events()) as unknown as Models['streamSimple'])
    const chunks = await drain(a.stream(request({ temperature: 0.2, maxTokens: 16, sessionId: 's1' as never })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const opts = probe.opts()
    expect(typeof opts.fetch).toBe('function')
    expect(opts.maxRetries).toBe(0)
    expect(opts.temperature).toBe(0.2)
    expect(opts.maxTokens).toBe(16)
    expect(opts.sessionId).toBe('s1')
    expect((opts.headers as Record<string, string>)['user-agent']).toMatch(/deepseek-harness\//)
  })

  it('dispatches through the prepared call generation', async () => {
    const a = adapter()
    async function* events(): AsyncGenerator<AssistantMessageEvent> {
      yield { type: 'done', message: {
        role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages',
        provider: 'mantle-claude', model: 'anthropic.claude-opus-4-8', stopReason: 'stop', timestamp: 0,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } } as unknown as AssistantMessageEvent
    }
    withMockModels(a, (() => events()) as unknown as Models['streamSimple'])
    const prepared = await a.prepareCall('mantle-claude', 'anthropic.claude-opus-4-8')
    const chunks = await drain(prepared.stream(request()))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('rethrows a non-abort, non-timeout provider error unchanged', async () => {
    const a = adapter()
    withMockModels(a, (() => { throw new Error('provider exploded') }) as unknown as Models['streamSimple'])
    await expect(drain(a.stream(request()))).rejects.toThrow(/provider exploded/)
  })

  it('rejects the unsupported stop option', async () => {
    await expect(drain(adapter().stream(request({ stop: ['x'] as never })))).rejects.toThrow(/does not support GenerateOptions.stop/)
  })

  it('rejects image input', async () => {
    const withImage = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1 } } as never] })
    await expect(drain(adapter().stream(request({ messages: [withImage] })))).rejects.toThrow(/does not support image input/)
  })

  it('rejects an unowned provider', async () => {
    await expect(drain(adapter().stream(request({ provider: 'nope' })))).rejects.toThrow(/does not own provider "nope"/)
  })

  it('reports a caller abort as ABORTED', async () => {
    const a = adapter()
    const controller = new AbortController()
    controller.abort()
    withMockModels(a, (() => { throw new Error('boom') }) as unknown as Models['streamSimple'])
    await expect(drain(a.stream(request({ signal: controller.signal })))).rejects.toThrow(/aborted by caller/)
  })

  it('reports a stream idle timeout as TIMEOUT', async () => {
    const a = new MantleAdapter(resolveConfig({ region: 'us-east-1', streamIdleTimeoutMs: 20 }))
    const hang = ((_m: unknown, _c: unknown, options?: { signal?: AbortSignal }): AsyncIterable<AssistantMessageEvent> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<AssistantMessageEvent>>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('idle-abort')))
        }),
        return: () => Promise.resolve({ done: true, value: undefined }),
      }),
    })) as unknown as Models['streamSimple']
    withMockModels(a, hang)
    await expect(drain(a.stream(request()))).rejects.toThrow(/idle timeout after 20ms/)
  })
})
