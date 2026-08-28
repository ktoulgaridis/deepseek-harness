/**
 * Real-composition guard: LlmRuntime and llm-mantle boot from a test-only
 * cordis.yml through the actual Loader + Include path, and both routes register
 * with resolvable model metadata and retry policy. The provider network is not
 * reached — this pins the seam composition, not a live completion (the live
 * both-shape 200 proof is captured separately).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmMantle from '@deepseek-ai/dsh-llm-mantle'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(region: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-mantle-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: llm-mantle',
    "  name: '@deepseek-ai/dsh-llm-mantle'",
    '  config:',
    `    region: ${region}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-llm-mantle', LlmMantle],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('llm-mantle real composition', () => {
  it('registers both routes with resolvable model metadata and a retry policy', async () => {
    const ctx = await loadComposition('us-east-1')

    const claudeModels = await ctx.llm.listModels('mantle-claude')
    expect(claudeModels).toEqual([
      { provider: 'mantle-claude', id: 'anthropic.claude-opus-4-8', name: 'Mantle Claude', inputModalities: ['text'] },
    ])
    const gptModels = await ctx.llm.listModels('mantle-gpt')
    expect(gptModels.map(model => model.id)).toEqual(['openai.gpt-5.6-sol'])

    const claudeInfo = await ctx.llm.resolveModelInfo('mantle-claude', 'anthropic.claude-opus-4-8')
    expect(claudeInfo.context?.contextWindow).toBe(200_000)
    expect(claudeInfo.inputModalities).toEqual(['text'])
    expect(claudeInfo.name).toBe('Mantle Claude')

    // Both routes are owned by the same adapter, each carrying a retry policy.
    expect(ctx.llm.providerRetryPolicy('mantle-claude')).toBeDefined()
    expect(ctx.llm.providerRetryPolicy('mantle-gpt')).toBeDefined()
  })

  it('rejects a second adapter for a route it already owns', async () => {
    const ctx = await loadComposition('us-east-1')
    const second = new LlmMantle.MantleAdapter(LlmMantle.resolveConfig({ region: 'us-east-1' }))
    expect(() => ctx.llm.registerAdapter(['mantle-claude'], second)).toThrow(/already registered/)
  })
})
