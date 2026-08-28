/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * This adapter serves text and tool-use turns; image input is not supported
 * (see the package README's Known Limitations). An image content block in any
 * message fails the request loud rather than being silently dropped.
 *
 * @module @deepseek-ai/dsh-llm-mantle/context
 */

import { ToolCallId, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Context as PiContext, Message as PiMessage, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'

/** Join the text blocks of a harness message. */
function flattenText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Flatten text recursively inside one tool result. */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? toolResultText(block.content) : '').join('')
}

/** Translate the request's declared tools into pi-ai's tool vocabulary. */
function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/** Assemble the request-level pi-ai context envelope. */
function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

/**
 * Convert text-only harness history to a pi-ai Context. Tool result names are
 * recovered from preceding assistant tool calls, and in-history system messages
 * fold into user messages because pi-ai carries a single `systemPrompt` slot.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @returns the pi-ai context; `tools` is omitted when the request declares none.
 * @throws LlmError `UNSUPPORTED_CONTENT` when any message carries an image block.
 */
export function toPiContext(
  options: GenerateOptions,
  onReplayDegrade?: (reason: string) => void,
): PiContext {
  const toolNames = new Map<ToolCallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('llm-mantle does not support image input', 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, onReplayDegrade)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(ToolCallId(block.id), block.name)
      messages.push(assistant)
      continue
    }
    const text = flattenText(message)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{
          type: 'text',
          text: toolResultText(result.content) || '(no output)',
        }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return piContext(options, messages)
}
