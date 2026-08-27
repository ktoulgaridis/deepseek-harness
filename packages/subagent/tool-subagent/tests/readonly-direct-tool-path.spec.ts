/**
 * PROOF (one fact): a child dispatched through the DIRECT `dsh-tool-subagent`
 * tool path with a top-level `toolFilter.allow` is STRUCTURALLY unable to
 * write — `edit`/`write`/`bash` are absent from its assembled tool catalog and
 * refuse to execute — while a negative control without the filter proves those
 * same tools were reachable. Real composition: the shipping spawn provider
 * composes a real child; only the MODEL boundary is scripted.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const REVIEWER_PERSONA = 'You are subagent_review: a read-only reviewer. You cannot modify files.'
const MUTATING = ['edit', 'write', 'bash']
const READONLY = ['read', 'grep', 'glob']

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/**
 * Build the smallest real composition: spawn provider + real fs/search/bash
 * tools registered as GLOBAL tools, plus `dsh-tool-subagent` bound to spawn.
 * `toolFilter`/`persona` are placed at the CONFIG TOP LEVEL (siblings of
 * `agentOptions`), which is where the tool forwards them from.
 */
async function build(opts: {
  script: Script
  toolFilter?: { allow?: string[]; deny?: string[] }
  persona?: string
}): Promise<{ ctx: Context; parent: Agent; adapter: MockAdapter }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-readonly-proof-'))
  dirs.push(dir)
  const ctx = new Context()
  const adapter = new MockAdapter(opts.script)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // Real global tools the child could otherwise reach.
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs) // read, write, edit
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true }) // grep, glob
  await ctx.plugin(ShellEnv)
  await ctx.plugin(LocalBashExecutor, { cwd: dir, timeoutMs: 30_000 })
  await ctx.plugin(ToolBash) // bash
  // The direct tool. toolFilter/persona are TOP-LEVEL config fields.
  await ctx.plugin(tool, {
    provider: 'spawn',
    ...opts.toolFilter ? { toolFilter: opts.toolFilter } : {},
    ...opts.persona ? { persona: opts.persona } : {},
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

/** Run the `subagent` tool through the real tool executor as the parent agent. */
async function dispatchSubagent(ctx: Context, parent: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('parent-subagent-call'),
    name: 'subagent',
    arguments: { description: 'review', prompt: 'Try to write a file, then report.', run_in_background: false },
    agent: parent,
  })
}

describe('read-only subagent via direct dsh-tool-subagent path (toolFilter.allow)', () => {
  it('ENFORCED: allow-list child EXCLUDES edit/write/bash, INCLUDES read/grep/glob, and refuses to execute write', async () => {
    const { ctx, parent, adapter } = await build({
      // Child: attempt the mutating `write` tool, then answer.
      script: [
        toolCallResponse('w1', 'write', { file_path: '/tmp/must-not-write.txt', content: 'x' }),
        textResponse('write is not available to me'),
      ],
      toolFilter: { allow: READONLY },
      persona: REVIEWER_PERSONA,
    })

    // Snapshot the child's assembled catalog THROUGH THE EXECUTOR (the tool
    // registry view for the child scope) at publication, before disposal.
    let catalog: string[] | undefined
    let writeVisible: boolean | undefined
    let readVisible: boolean | undefined
    ctx.on('subagent/start', (info) => {
      const child = ctx.agents.get(info.id)
      if (info.provider !== 'spawn' || child === undefined) return
      catalog = ctx.tools.schemas(child).map(s => s.name).sort()
      writeVisible = ctx.tools.get('write', child) !== undefined
      readVisible = ctx.tools.get('read', child) !== undefined
    })
    // Capture the child log at settlement (still registered) to see the
    // attempted-write denial from the executor.
    let childToolResults: string[] = []
    ctx.on('subagent/end', (info) => {
      const child = ctx.agents.get(info.id)
      if (child === undefined) return
      childToolResults = child.session.events
        .filter(e => e.type === 'tool/result')
        .map(e => JSON.stringify(e.data))
    })

    const result = await dispatchSubagent(ctx, parent)

    expect(result.isError).toBe(false)
    // Catalog through the executor: mutating tools gone, read-only tools kept.
    expect(catalog).toBeDefined()
    for (const t of MUTATING) expect(catalog).not.toContain(t)
    for (const t of READONLY) expect(catalog).toContain(t)
    expect(writeVisible).toBe(false)
    expect(readVisible).toBe(true)
    // The attempted write reached the executor and was rejected as UNKNOWN_TOOL.
    expect(childToolResults.some(r => r.toLowerCase().includes('unknown tool'))).toBe(true)
    // The reviewer persona shadowed the deployment persona in the child request.
    expect(adapter.requests[0]?.system ?? '').toContain('subagent_review')
  })

  it('NEGATIVE CONTROL: same composition WITHOUT toolFilter — child INCLUDES edit/write/bash (they were reachable)', async () => {
    const { ctx, parent } = await build({
      script: [textResponse('ok')],
      // No toolFilter, no persona.
    })
    let catalog: string[] | undefined
    ctx.on('subagent/start', (info) => {
      const child = ctx.agents.get(info.id)
      if (info.provider !== 'spawn' || child === undefined) return
      catalog = ctx.tools.schemas(child).map(s => s.name).sort()
    })

    const result = await dispatchSubagent(ctx, parent)

    expect(result.isError).toBe(false)
    expect(catalog).toBeDefined()
    for (const t of [...MUTATING, ...READONLY]) expect(catalog).toContain(t)
  })
})
