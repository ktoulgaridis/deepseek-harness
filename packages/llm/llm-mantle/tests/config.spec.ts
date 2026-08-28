/**
 * Config resolution: defaults, endpoint construction from the region, and the
 * beyond-schema numeric bounds re-judged for programmatic construction.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REGION,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveConfig,
} from '../src/config.ts'

describe('resolveConfig', () => {
  it('defaults the region, caps, and timeout and builds both route endpoints', () => {
    const resolved = resolveConfig({})
    expect(resolved.region).toBe(DEFAULT_REGION)
    expect(resolved.streamIdleTimeoutMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    expect(resolved.routes.map(route => route.provider)).toEqual(['mantle-claude', 'mantle-gpt'])
    const claude = resolved.routes[0]!
    const gpt = resolved.routes[1]!
    expect(claude.baseURL).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic')
    expect(claude.model).toBe('anthropic.claude-opus-4-8')
    expect(claude.api).toBe('anthropic-messages')
    expect(gpt.baseURL).toBe('https://bedrock-mantle.us-east-1.api.aws/openai/v1')
    expect(gpt.model).toBe('openai.gpt-5.6-sol')
    expect(gpt.api).toBe('openai-responses')
    expect(claude.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(claude.maxTokens).toBe(DEFAULT_MAX_TOKENS)
  })

  it('substitutes a configured region into both endpoints', () => {
    const resolved = resolveConfig({ region: 'eu-west-2', contextWindow: 400_000, maxTokens: 4_096 })
    expect(resolved.routes[0]!.baseURL).toBe('https://bedrock-mantle.eu-west-2.api.aws/anthropic')
    expect(resolved.routes[1]!.baseURL).toBe('https://bedrock-mantle.eu-west-2.api.aws/openai/v1')
    expect(resolved.routes[0]!.contextWindow).toBe(400_000)
    expect(resolved.routes[1]!.maxTokens).toBe(4_096)
  })

  it('rejects an empty region', () => {
    expect(() => resolveConfig({ region: '' })).toThrow(/region must be a non-empty string/)
  })

  it('rejects a non-positive or non-integer maxTokens', () => {
    expect(() => resolveConfig({ maxTokens: 0 })).toThrow(/maxTokens must be a positive safe integer/)
    expect(() => resolveConfig({ maxTokens: 1.5 })).toThrow(/maxTokens must be a positive safe integer/)
  })

  it('rejects a non-positive contextWindow', () => {
    expect(() => resolveConfig({ contextWindow: -1 })).toThrow(/contextWindow must be a positive safe integer/)
  })

  it('rejects a non-positive or non-finite streamIdleTimeoutMs', () => {
    expect(() => resolveConfig({ streamIdleTimeoutMs: 0 })).toThrow(/streamIdleTimeoutMs must be a positive finite number/)
    expect(() => resolveConfig({ streamIdleTimeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow(/streamIdleTimeoutMs must be a positive finite number/)
  })
})
