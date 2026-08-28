/**
 * Register a {@link MantleAdapter} for the two Bedrock Mantle routes —
 * `mantle-claude` (anthropic-messages) and `mantle-gpt` (openai-responses) — on
 * `ctx.llm`. Every request is SigV4-signed from the ambient AWS credential
 * chain: there is no api-key, no `apiKeyEnv`, and no bearer on the wire. The
 * only deployment knob is the AWS region (plus advisory request caps); the
 * model ids and endpoints are the gateway's own catalog.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-mantle'
 *   config:
 *     region: us-east-1
 * ```
 *
 * The composition must run where the AWS SDK default provider chain resolves
 * credentials (SSO, instance role, or exported keys) with permission to invoke
 * `bedrock-mantle`.
 *
 * @module @deepseek-ai/dsh-llm-mantle
 */

import type { Context } from '@deepseek-ai/cordis'
import { MantleAdapter } from './adapter.ts'
import { Config, resolveConfig } from './config.ts'

export { MantleAdapter } from './adapter.ts'
export { Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_REGION, DEFAULT_STREAM_IDLE_TIMEOUT_MS, ROUTE_TEMPLATES, resolveConfig } from './config.ts'
export type { ResolvedMantleConfig } from './config.ts'
export { buildModel, buildProvider, MANTLE_SERVICE } from './provider.ts'
export type { MantleApi, RouteSpec } from './provider.ts'
export { createSigV4Fetch, SIGV4_PLACEHOLDER_KEY } from './sigv4.ts'
export type { SigV4Config } from './sigv4.ts'

export const name = 'llm-mantle'
export const inject = ['llm']

/**
 * Register the Mantle adapter for both routes.
 *
 * Configuration resolves once at load: a change requires a restart (see the
 * package README's Known Limitations). The route set is fixed, so the
 * registration is captured once and never replaced.
 * @param ctx - Cordis context carrying the `llm` service.
 * @param config - raw plugin config; the region and advisory caps.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const adapter = new MantleAdapter(resolved)
  ctx.llm.registerAdapter(resolved.routes.map(route => route.provider), adapter)
}
