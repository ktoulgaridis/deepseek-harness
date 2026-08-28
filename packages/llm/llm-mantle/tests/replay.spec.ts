/**
 * Replay projection and assistant-history reconstruction: a successful pi-ai
 * response projects to the durable envelope, a matching envelope reconstructs a
 * native message, and any unusable envelope degrades to provider-neutral content.
 */

import { describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { ToolCallId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ReplayEnvelope as HarnessReplay } from '@deepseek-ai/dsh-llm'
import { toPiAssistant, toPiReplayState } from '../src/replay.ts'

function piMessage(content: AssistantMessage['content'], over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'mantle-claude',
    model: 'anthropic.claude-opus-4-8',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
    ...over,
  } as AssistantMessage
}

function assistant(content: Message['content'], replayState?: unknown): Message {
  return createAssistantMessage({
    content,
    source: { provider: 'mantle-claude', model: 'anthropic.claude-opus-4-8', ...replayState === undefined ? {} : { replayState: replayState as HarnessReplay } },
  })
}

describe('toPiReplayState', () => {
  it('projects text, thinking, and tool-call blocks with their signatures', () => {
    const state = toPiReplayState(piMessage([
      { type: 'text', text: 'hi', textSignature: 'ts' },
      { type: 'thinking', thinking: 'mm', thinkingSignature: 'th', redacted: true },
      { type: 'toolCall', id: 'c1', name: 'do', arguments: {}, thoughtSignature: 'gt' },
    ], { responseModel: 'rm', responseId: 'rid', stopReason: 'toolUse' })) as unknown as { blocks: unknown[]; response: Record<string, unknown> }
    expect(state.response).toMatchObject({ kind: 'pi-ai', version: 2, provider: 'mantle-claude', responseModel: 'rm', responseId: 'rid', stopReason: 'toolUse' })
    expect(state.blocks).toEqual([
      { type: 'text', textSignature: 'ts' },
      { type: 'reasoning', thinkingSignature: 'th', redacted: true },
      { type: 'tool-call', thoughtSignature: 'gt' },
    ])
  })

  it('omits absent optional signatures and response ids', () => {
    const state = toPiReplayState(piMessage([{ type: 'text', text: 'hi' }])) as unknown as { blocks: unknown[]; response: Record<string, unknown> }
    expect(state.blocks).toEqual([{ type: 'text' }])
    expect(state.response).not.toHaveProperty('responseModel')
    expect(state.response).not.toHaveProperty('responseId')
  })

  it('projects thinking and tool-call blocks that carry no signatures', () => {
    const state = toPiReplayState(piMessage([
      { type: 'thinking', thinking: 'mm' },
      { type: 'toolCall', id: 'c1', name: 'do', arguments: {} },
    ])) as unknown as { blocks: unknown[] }
    expect(state.blocks).toEqual([{ type: 'reasoning' }, { type: 'tool-call' }])
  })
})

function validEnvelope(over: Record<string, unknown> = {}, blocks: unknown[] = [{ type: 'text' }]): unknown {
  return { response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: 'mantle-claude', model: 'anthropic.claude-opus-4-8', stopReason: 'stop', ...over }, blocks }
}

describe('toPiAssistant', () => {
  it('reconstructs a native message from a matching replay envelope', () => {
    const msg = assistant([{ type: 'text', text: 'hi' }], validEnvelope({ responseModel: 'rm', responseId: 'rid' }))
    const pi = toPiAssistant(msg)
    expect(pi).toMatchObject({ role: 'assistant', provider: 'mantle-claude', model: 'anthropic.claude-opus-4-8', responseModel: 'rm', responseId: 'rid' })
    expect(pi.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('reconstructs a text block that carries a signature', () => {
    const msg = assistant([{ type: 'text', text: 'hi' }], validEnvelope({}, [{ type: 'text', textSignature: 'ts' }]))
    expect(toPiAssistant(msg).content).toEqual([{ type: 'text', text: 'hi', textSignature: 'ts' }])
  })

  it('treats a non-model source as foreign, dropping provider/model identity', () => {
    const msg = {
      id: 'm1' as never,
      role: 'assistant',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hi' }],
    } as unknown as Message
    const pi = toPiAssistant(msg)
    expect(pi).toMatchObject({ api: 'dsh-foreign', provider: 'dsh-foreign', model: 'dsh-foreign' })
  })

  it('reconstructs reasoning and tool-call blocks with signatures', () => {
    const msg = assistant(
      [{ type: 'reasoning', text: 'mm' }, { type: 'tool-call', id: ToolCallId('c1'), name: 'do', arguments: '{"a":1}' }],
      validEnvelope({}, [{ type: 'reasoning', thinkingSignature: 'th', redacted: true }, { type: 'tool-call', thoughtSignature: 'gt' }]),
    )
    const pi = toPiAssistant(msg)
    expect(pi.content).toEqual([
      { type: 'thinking', thinking: 'mm', thinkingSignature: 'th', redacted: true },
      { type: 'toolCall', id: 'c1', name: 'do', arguments: { a: 1 }, thoughtSignature: 'gt' },
    ])
  })

  it('reconstructs reasoning and tool-call blocks when the envelope carries no signatures', () => {
    const msg = assistant(
      [{ type: 'reasoning', text: 'mm' }, { type: 'tool-call', id: ToolCallId('c1'), name: 'do', arguments: '{}' }],
      validEnvelope({}, [{ type: 'reasoning' }, { type: 'tool-call' }]),
    )
    const pi = toPiAssistant(msg)
    expect(pi.content).toEqual([
      { type: 'thinking', thinking: 'mm' },
      { type: 'toolCall', id: 'c1', name: 'do', arguments: {} },
    ])
  })

  it('converts a model-source message without replay state to provider-neutral content', () => {
    const pi = toPiAssistant(assistant([
      { type: 'text', text: 'hi' },
      { type: 'reasoning', text: 'mm' },
      { type: 'tool-call', id: ToolCallId('c1'), name: 'do', arguments: 'not json' },
    ]))
    expect(pi.api).toBe('dsh-foreign')
    expect(pi.stopReason).toBe('toolUse')
    expect(pi.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'mm' },
      { type: 'toolCall', id: 'c1', name: 'do', arguments: {} },
    ])
  })

  it('skips a plugin-added block type when converting to provider-neutral content', () => {
    const pi = toPiAssistant(assistant([{ type: 'text', text: 'keep' }, { type: 'mystery' } as never]))
    expect(pi.content).toEqual([{ type: 'text', text: 'keep' }])
  })

  it('rejects an assistant image block that pi-ai cannot represent', () => {
    const msg = assistant([{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1 } } as never])
    expect(() => toPiAssistant(msg)).toThrow(/cannot represent structured assistant image output/)
  })

  it('degrades every unusable replay envelope and reports the reason', () => {
    const cases: unknown[] = [
      'not-an-object',
      { blocks: [] },
      { response: 'x', blocks: [] },
      { response: { kind: 'other' }, blocks: [] },
      { response: { kind: 'pi-ai', version: 1 }, blocks: [] },
      { response: { kind: 'pi-ai', version: 2, api: '', provider: 'p', model: 'm', stopReason: 'stop' }, blocks: [] },
      validEnvelope({ stopReason: 'weird' }),
      validEnvelope({ responseModel: 5 }),
      validEnvelope({ responseId: 5 }),
      { response: { kind: 'pi-ai', version: 2, api: 'a', provider: 'mantle-claude', model: 'anthropic.claude-opus-4-8', stopReason: 'stop' }, blocks: 'no' },
      validEnvelope({}, ['not-object']),
      validEnvelope({}, [{ type: 'mystery' }]),
      validEnvelope({}, [{ type: 'text', textSignature: 9 }]),
      validEnvelope({}, [{ type: 'reasoning', redacted: 'no' }]),
      validEnvelope({ provider: 'other' }),
      validEnvelope({ model: 'other' }),
      validEnvelope({}, [{ type: 'text' }, { type: 'text' }]),
      validEnvelope({}, [{ type: 'reasoning' }]),
    ]
    for (const state of cases) {
      const onDegrade = vi.fn()
      const pi = toPiAssistant(assistant([{ type: 'text', text: 'hi' }], state), onDegrade)
      expect(pi.api).toBe('dsh-foreign')
      expect(onDegrade).toHaveBeenCalledOnce()
    }
  })
})
