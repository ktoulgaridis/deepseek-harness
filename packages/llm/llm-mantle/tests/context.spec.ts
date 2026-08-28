/**
 * Harness history → pi-ai Context conversion: role folding, tool-result name
 * recovery, tool declarations, and the image-input rejection.
 */

import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { toPiContext } from '../src/context.ts'

function options(messages: Message[], over: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'mantle-claude', model: 'anthropic.claude-opus-4-8', messages, ...over } as GenerateOptions
}

const user = (text: string): Message => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

describe('toPiContext', () => {
  it('maps system option and a user turn, and declares tools', () => {
    const ctx = toPiContext(options([user('hello')], {
      system: 'be terse',
      tools: [{ name: 'do', description: 'does', parameters: { type: 'object', properties: {} } }],
    }))
    expect(ctx.systemPrompt).toBe('be terse')
    expect(ctx.messages).toEqual([{ role: 'user', content: 'hello', timestamp: 0 }])
    expect(ctx.tools).toEqual([{ name: 'do', description: 'does', parameters: { type: 'object', properties: {} } }])
  })

  it('folds an in-history system message into a user message and omits empty tools', () => {
    const system = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'sys' }] })
    // Force a system role for the history-fold path.
    const asSystem = { ...system, role: 'system' as const }
    const ctx = toPiContext(options([asSystem, user('hi')], { tools: [] }))
    expect(ctx.messages[0]).toEqual({ role: 'user', content: 'sys', timestamp: 0 })
    expect(ctx).not.toHaveProperty('tools')
  })

  it('recovers a tool-result name from the preceding assistant tool call', () => {
    const call = createAssistantMessage({
      // A leading text block exercises the non-tool-call branch of the name scan.
      content: [{ type: 'text', text: 'let me run it' }, { type: 'tool-call', id: ToolCallId('c1'), name: 'do', arguments: '{}' }],
      source: { provider: 'mantle-claude', model: 'anthropic.claude-opus-4-8' },
    })
    const result = createToolResultMessage({
      callId: ToolCallId('c1'),
      content: [{ type: 'text', text: 'output' }],
      isError: false,
    })
    const ctx = toPiContext(options([user('run it'), call, result]))
    const toolResult = ctx.messages.find(m => m.role === 'toolResult')
    expect(toolResult).toMatchObject({ toolName: 'do', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'output' }] })
  })

  it('emits (no output) for an empty tool result and skips the empty user text message', () => {
    const result = createToolResultMessage({ callId: ToolCallId('c9'), content: [], isError: true })
    const ctx = toPiContext(options([result]))
    // No leading empty user message; only the tool-result message.
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0]).toMatchObject({ role: 'toolResult', toolName: 'unknown', isError: true, content: [{ type: 'text', text: '(no output)' }] })
  })

  it('flattens nested tool-result text and skips non-text blocks, defaulting a missing isError', () => {
    const nested: Message = {
      id: 'm-tr' as never,
      role: 'user',
      source: { kind: 'tool', callId: ToolCallId('c2') },
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId('c2'),
        content: [
          { type: 'text', text: 'top ' },
          { type: 'tool-result', toolCallId: ToolCallId('c2'), content: [{ type: 'text', text: 'deep' }], isError: false },
          { type: 'reasoning', text: 'ignored' },
        ],
        // isError intentionally omitted to exercise the `?? false` default.
      }],
    } as unknown as Message
    const ctx = toPiContext(options([nested]))
    const toolResult = ctx.messages.find(m => m.role === 'toolResult')
    expect(toolResult).toMatchObject({ isError: false, content: [{ type: 'text', text: 'top deep' }] })
  })

  it('rejects image input loud', () => {
    const withImage = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1 } } as never],
    })
    expect(() => toPiContext(options([withImage]))).toThrow(/does not support image input/)
  })
})
