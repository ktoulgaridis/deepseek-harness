/**
 * pi-ai event → StreamChunk translation, usage mapping, and terminal-reason
 * classification.
 */

import { describe, expect, it } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { mapStopReason, mapUsage, toStreamChunks } from '../src/stream.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

function usage(over: Partial<PiUsage> = {}): PiUsage {
  return {
    input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...over,
  }
}

function message(over: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    api: 'anthropic-messages',
    provider: 'mantle-claude',
    model: 'anthropic.claude-opus-4-8',
    usage: usage(),
    stopReason: 'stop',
    timestamp: 0,
    ...over,
  } as AssistantMessage
}

async function* gen(events: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
  for (const event of events) yield event
}

async function collect(events: AssistantMessageEvent[], contextWindow?: number): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of toStreamChunks(gen(events), contextWindow)) out.push(chunk)
  return out
}

describe('mapUsage', () => {
  it('maps input/output and includes cache fields only when non-zero', () => {
    expect(mapUsage(usage())).toEqual({ inputTokens: 3, outputTokens: 1 })
    expect(mapUsage(usage({ cacheRead: 5, cacheWrite: 2 }))).toEqual({
      inputTokens: 3, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2,
    })
  })
})

describe('mapStopReason', () => {
  it('maps the terminal stop reasons', () => {
    expect(mapStopReason(message({ stopReason: 'stop' }))).toEqual({ kind: 'stop' })
    expect(mapStopReason(message({ stopReason: 'length' }))).toEqual({ kind: 'max-tokens' })
    expect(mapStopReason(message({ stopReason: 'toolUse' }))).toEqual({ kind: 'tool-calls' })
    expect(mapStopReason(message({ stopReason: 'aborted', errorMessage: 'stopped' })))
      .toEqual({ kind: 'aborted', failure: { message: 'stopped', code: 'ABORTED' } })
    expect((mapStopReason(message({ stopReason: 'aborted' })) as { failure?: { message: string } }).failure?.message).toBe('pi-ai stream aborted')
  })

  it('maps an empty completed response to EMPTY_RESPONSE', () => {
    const reason = mapStopReason(message({ stopReason: 'stop', content: [] }))
    expect(reason).toMatchObject({ kind: 'error', failure: { code: 'EMPTY_RESPONSE' } })
  })

  it('maps non-terminal streamed stop reasons loud', () => {
    for (const stopReason of ['pending', 'deferred'] as const) {
      expect(mapStopReason(message({ stopReason }))).toMatchObject({ kind: 'error', failure: { code: 'PI_AI_ERROR' } })
    }
  })

  it('detects a harness context-window overflow from the error text', () => {
    const reason = mapStopReason(message({ stopReason: 'error', errorMessage: 'maximum context length exceeded' }))
    expect(reason).toMatchObject({ kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } })
  })

  it('classifies error messages into stable codes', () => {
    const codeFor = (text: string): string => {
      const reason = mapStopReason(message({ stopReason: 'error', errorMessage: text }))
      return (reason as { failure?: { code: string } }).failure?.code ?? reason.kind
    }
    expect(codeFor('HTTP 401 unauthorized')).toBe('AUTH')
    expect(codeFor('403 forbidden')).toBe('AUTH')
    expect(codeFor('quota exceeded for this key')).toBe('QUOTA')
    expect(codeFor('429 too many requests')).toBe('RATE_LIMIT')
    expect(codeFor('413 payload too large')).toBe('INVALID_REQUEST')
    expect(codeFor('400 invalid request')).toBe('INVALID_REQUEST')
    expect(codeFor('500 internal error')).toBe('SERVER')
    expect(codeFor('the request timed out')).toBe('TIMEOUT')
    expect(codeFor('stream ended before message_stop')).toBe('TRANSPORT')
    expect(codeFor('other side closed')).toBe('TRANSPORT')
    expect(codeFor('terminated')).toBe('TRANSPORT')
    expect(codeFor('some unmapped provider failure')).toBe('PI_AI_ERROR')
    expect(codeFor(undefined as unknown as string)).toBe('PI_AI_ERROR')
  })
})

describe('toStreamChunks', () => {
  it('translates a full text + reasoning + tool-call turn ending in done', async () => {
    const events: AssistantMessageEvent[] = [
      { type: 'start' } as AssistantMessageEvent,
      { type: 'text_start', contentIndex: 0 } as AssistantMessageEvent,
      { type: 'text_delta', contentIndex: 0, delta: 'he' } as AssistantMessageEvent,
      { type: 'text_end', contentIndex: 0, content: 'hello' } as AssistantMessageEvent,
      { type: 'thinking_start', contentIndex: 1 } as AssistantMessageEvent,
      { type: 'thinking_delta', contentIndex: 1, delta: 'mm' } as AssistantMessageEvent,
      { type: 'thinking_end', contentIndex: 1, content: 'mmm' } as AssistantMessageEvent,
      { type: 'toolcall_start', contentIndex: 2, partial: { content: [undefined, undefined, { type: 'toolCall', id: 'c1', name: 'do' }] } } as unknown as AssistantMessageEvent,
      { type: 'toolcall_delta', contentIndex: 2, delta: '{"a":' } as AssistantMessageEvent,
      { type: 'toolcall_end', contentIndex: 2, toolCall: { id: 'c1', name: 'do', arguments: { a: 1 } } } as unknown as AssistantMessageEvent,
      { type: 'done', message: message({ content: [{ type: 'text', text: 'hello' }], usage: usage() }) } as AssistantMessageEvent,
    ]
    const chunks = await collect(events, 200_000)
    const types = chunks.map(c => c.type)
    expect(types).toEqual([
      'block-start', 'text-delta', 'block-end',
      'block-start', 'reasoning-delta', 'block-end',
      'block-start', 'tool-call-delta', 'block-end',
      'usage', 'finish',
    ])
    const toolEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(toolEnd).toMatchObject({ block: { arguments: '{"a":1}', name: 'do' } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('handles a toolcall_start whose partial has no tool block, then a delta with no known id', async () => {
    const events: AssistantMessageEvent[] = [
      { type: 'toolcall_start', contentIndex: 0, partial: { content: [] } } as unknown as AssistantMessageEvent,
      { type: 'toolcall_delta', contentIndex: 0, delta: '{}' } as AssistantMessageEvent,
      // A delta at an index that never had a start: the id/name map has no entry.
      { type: 'toolcall_delta', contentIndex: 9, delta: 'x' } as AssistantMessageEvent,
      { type: 'done', message: message({ content: [{ type: 'text', text: 'x' }] }) } as AssistantMessageEvent,
    ]
    const chunks = await collect(events)
    const deltas = chunks.filter(c => c.type === 'tool-call-delta')
    expect(deltas[0]).toMatchObject({ id: '', argumentsDelta: '{}' })
    expect(deltas[0]).not.toHaveProperty('name')
    expect(deltas[1]).toMatchObject({ id: '', argumentsDelta: 'x' })
  })

  it('maps usage-based context overflow with no error text to CONTEXT_WINDOW_EXCEEDED', () => {
    const reason = mapStopReason(
      message({ stopReason: 'stop', content: [{ type: 'text', text: 'partial' }], usage: usage({ input: 200_001, output: 1 }) }),
      200_000,
    )
    expect(reason).toMatchObject({ kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } })
    expect((reason as { failure?: { message: string } }).failure?.message).toMatch(/context overflow/)
  })

  it('delivers an in-stream error event as usage then an error finish', async () => {
    const chunks = await collect([
      { type: 'error', error: message({ stopReason: 'error', errorMessage: '500 boom' }) } as AssistantMessageEvent,
    ])
    expect(chunks.map(c => c.type)).toEqual(['usage', 'finish'])
    expect(chunks[1]).toMatchObject({ type: 'finish', reason: { failure: { code: 'SERVER' } } })
  })

  it('throws STREAM_CLOSED when the source ends without a terminal event', async () => {
    await expect(collect([{ type: 'text_delta', contentIndex: 0, delta: 'x' } as AssistantMessageEvent]))
      .rejects.toThrow(/ended without done\/error/)
  })
})
