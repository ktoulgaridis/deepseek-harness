/**
 * Provider and model construction: the model descriptor is text-only and
 * non-reasoning, and the route's auth resolves the SigV4 placeholder key that
 * only lets the SDK construct.
 */

import { describe, expect, it } from 'vitest'
import { buildModel, buildProvider, MANTLE_SERVICE } from '../src/provider.ts'
import { SIGV4_PLACEHOLDER_KEY } from '../src/sigv4.ts'
import type { RouteSpec } from '../src/provider.ts'

const spec: RouteSpec = {
  provider: 'mantle-claude',
  displayName: 'Mantle Claude',
  api: 'anthropic-messages',
  baseURL: 'https://bedrock-mantle.us-east-1.api.aws/anthropic',
  model: 'anthropic.claude-opus-4-8',
  contextWindow: 200_000,
  maxTokens: 8_192,
}

describe('provider construction', () => {
  it('builds a text-only, non-reasoning model routed at the endpoint', () => {
    const model = buildModel(spec)
    expect(model).toMatchObject({
      id: 'anthropic.claude-opus-4-8',
      api: 'anthropic-messages',
      provider: 'mantle-claude',
      baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/anthropic',
      reasoning: false,
      input: ['text'],
      contextWindow: 200_000,
      maxTokens: 8_192,
    })
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('MANTLE_SERVICE is the bedrock-mantle signing service', () => {
    expect(MANTLE_SERVICE).toBe('bedrock-mantle')
  })

  it('resolves the placeholder api-key that only lets the SDK construct', async () => {
    const provider = buildProvider(spec)
    expect(provider.id).toBe('mantle-claude')
    const apiKey = provider.auth.apiKey
    expect(apiKey).toBeDefined()
    const resolved = await apiKey!.resolve({} as never)
    expect(resolved).toEqual({ auth: { apiKey: SIGV4_PLACEHOLDER_KEY }, source: 'Mantle Claude' })
  })

  it('builds the openai-responses route', () => {
    const provider = buildProvider({ ...spec, provider: 'mantle-gpt', displayName: 'Mantle GPT', api: 'openai-responses', model: 'openai.gpt-5.6-sol', baseURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1' })
    expect(provider.getModels().map(m => m.id)).toEqual(['openai.gpt-5.6-sol'])
  })
})
