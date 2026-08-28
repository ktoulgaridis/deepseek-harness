/**
 * Construction of the pi-ai `Provider` and `Model` one Mantle route registers
 * into the adapter's `Models` collection.
 *
 * Every route is hand-built through `createProvider` over one wire protocol —
 * pi-ai ships no Bedrock Mantle catalog entry — with a placeholder api-key auth
 * that only lets the SDK construct; the request itself carries no bearer,
 * because {@link module:@deepseek-ai/dsh-llm-mantle/sigv4} SigV4-signs every
 * request through the per-request `fetch` option the adapter passes to
 * `streamSimple`.
 *
 * @module @deepseek-ai/dsh-llm-mantle/provider
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, ApiKeyAuth, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { SIGV4_PLACEHOLDER_KEY } from './sigv4.ts'

/** The SigV4 service name every Mantle request signs under. */
export const MANTLE_SERVICE = 'bedrock-mantle'

/** The wire protocol identifiers a Mantle route may name. */
export type MantleApi = 'anthropic-messages' | 'openai-responses'

/**
 * Wire protocols a Mantle route may speak, mapped to pi-ai's lazily loaded
 * implementations. The two the gateway serves: Claude models over
 * `anthropic-messages`, GPT models over `openai-responses`.
 */
const PROTOCOLS: Readonly<Record<MantleApi, () => ProviderStreams>> = {
  'anthropic-messages': anthropicMessagesApi,
  'openai-responses': openAIResponsesApi,
}

/**
 * Api-key auth for a SigV4 route. It resolves a placeholder key regardless of
 * credential so the provider SDK constructs a client; the signing `fetch` the
 * adapter passes strips the header that key produces before signing, so the
 * placeholder never reaches the network. The route needs no credential
 * reference and resolves no secret.
 * @param name - display name used as the resolution's status label.
 * @returns the api-key auth for a SigV4-authenticated route.
 */
function sigv4ApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: () => Promise.resolve({ auth: { apiKey: SIGV4_PLACEHOLDER_KEY }, source: name }),
  }
}

/** The resolved facts one route's provider and model are built from. */
export interface RouteSpec {
  /** Provider route key; also the `Models` collection key and the model's `provider`. */
  provider: string
  /** Display name for selectors and status labels. */
  displayName: string
  /** Wire protocol this route speaks. */
  api: MantleApi
  /** Fully-resolved endpoint base (region already substituted). */
  baseURL: string
  /** Mantle model id sent on the wire. */
  model: string
  /** Advertised context capacity for this model. */
  contextWindow: number
  /** Per-request output-token cap applied when the request names none. */
  maxTokens: number
}

/**
 * Build the single pi-ai `Model` a Mantle route serves. Text-only input and no
 * reasoning metadata: this adapter serves text and tool-use turns, and offers
 * no reasoning-effort control (see the package README's Known Limitations).
 * Cost is zeroed because billing is settled by the AWS account behind the
 * gateway, not derived from a per-token price table here.
 * @param spec - the resolved route facts.
 * @returns the model descriptor pi-ai routes requests through.
 */
export function buildModel(spec: RouteSpec): Model<Api> {
  return {
    id: spec.model,
    name: spec.displayName,
    api: spec.api,
    provider: spec.provider,
    baseUrl: spec.baseURL,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  }
}

/**
 * Build the pi-ai provider for one Mantle route.
 * @param spec - the resolved route facts.
 * @returns the provider to register in the adapter's `Models` collection.
 */
export function buildProvider(spec: RouteSpec): Provider {
  return createProvider({
    id: spec.provider,
    name: spec.displayName,
    baseUrl: spec.baseURL,
    auth: { apiKey: sigv4ApiKeyAuth(spec.displayName) },
    models: [buildModel(spec)],
    api: PROTOCOLS[spec.api](),
  })
}
