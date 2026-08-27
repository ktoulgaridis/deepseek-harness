/**
 * Construction of the pi-ai `Provider` that one configured route registers into
 * the adapter's `Models` collection.
 *
 * Two constructions, one decision: a route the installed catalog ships, whose
 * profile does not override the wire protocol, **reuses that catalog provider**
 * with its models replaced — the catalog provider owns API implementations this
 * package cannot reconstruct (Bedrock loads its Smithy module through a
 * separate entry point), so rebuilding it from parts would silently narrow
 * which providers work. Every other route — one pi-ai has never heard of, or a
 * catalog route pointed at a different protocol — is built by `createProvider`
 * over the protocol table below.
 *
 * Credentials never reach this module's storage: the harness resolves a route's
 * key through `ctx.credentials` before the request enters pi-ai and hands it
 * over as a stream option, which `Models` presents to `resolve()` as the
 * credential key.
 *
 * @module dsh-llm-pi-ai/provider
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, ApiKeyAuth, Model, Provider, ProviderRequestOptions, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { catalogProvider } from './catalog.ts'
import { createSigV4Fetch, SIGV4_PLACEHOLDER_KEY } from './sigv4.ts'
import type { SigV4Config } from './sigv4.ts'

/**
 * Wire protocols a configured route may name, mapped to pi-ai's lazily loaded
 * implementations. Each entry is the factory that pi-ai's matching provider
 * factory uses, so a hand-declared route reaches exactly the implementation a
 * catalog route would.
 *
 * The table is deliberately narrow: the protocols a hand-declared route
 * actually reaches for today, each completely describable with a key, an
 * endpoint, and headers. Bedrock signs with SigV4 over AWS credentials and a
 * region, Vertex needs a project, a location, and application-default
 * credentials, Azure needs provider environment plus an api-version, and Codex
 * authenticates through OAuth — none of which this configuration shape can
 * express, so offering them would hand back a provider that cannot
 * authenticate. The remainder are absent for want of a consumer rather than a
 * blocker: each is one line here once a deployment needs it. Catalog routes
 * still reach every protocol through their own provider; only an explicit
 * override is refused.
 */
const PROTOCOLS: Readonly<Record<string, () => ProviderStreams>> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
}

/**
 * Every wire protocol a configured route may name, most-reached first. The
 * order is the table's and therefore stable; a configuration surface offering
 * a choice presents the first as its default, which is why the protocol a
 * hand-declared gateway most often speaks — and the one endpoint interrogation
 * can read — leads.
 * @returns the supported protocol identifiers.
 */
export function supportedProtocols(): readonly string[] {
  return Object.keys(PROTOCOLS)
}

/**
 * Api-key auth for a route the harness authenticates itself. `Models` calls
 * this after the adapter has already resolved the route's credential, so a
 * missing key here is not this layer's failure: a named-but-unresolvable
 * reference has already failed the request with `MISSING_CREDENTIAL`, and a
 * route naming no credential at all is deliberately unauthenticated. Reporting
 * it as configured hands the decision to the protocol, which is where the
 * requirement actually lives — pi-ai's OpenAI-compatible implementation, for
 * one, still insists on a key or an `Authorization` header of its own.
 * @param name - display name used as the resolution's status label.
 * @returns the api-key auth for a harness-authenticated route.
 */
function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/**
 * Api-key auth for a SigV4 route. It resolves a placeholder key regardless of
 * credential so the provider SDK constructs a client; the signing `fetch`
 * {@link buildProvider} wraps strips the header that key produces before
 * signing, so the placeholder never reaches the network. The route needs no
 * `apiKeyEnv` and resolves no secret.
 * @param name - display name used as the resolution's status label.
 * @returns the api-key auth for a SigV4-authenticated route.
 */
function sigv4ApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: () => Promise.resolve({ auth: { apiKey: SIGV4_PLACEHOLDER_KEY }, source: name }),
  }
}

/** The resolved route facts provider construction reads. */
export interface ProviderSpec {
  /** Provider route key; also the `Models` collection key and each model's `provider`. */
  provider: string
  /** Display name for selectors and status labels. */
  displayName: string
  /** Wire protocol override; absent means each model keeps its catalog protocol. */
  api?: string
  /** Endpoint override already applied to {@link models}; kept for provider-level display. */
  baseURL?: string
  /** The route's materialized models, in configuration order. */
  models: readonly Model<Api>[]
  /**
   * Whether the profile names a credential, which it does through `apiKeyEnv`
   * alone: configuration carries the reference, never the secret. Only that
   * decides whether {@link routeAuth} adds the harness's own api-key method to
   * a catalog provider that offers none; the key itself still arrives per
   * request, never at construction.
   */
  namesCredential: boolean
  /**
   * SigV4 signing parameters when this route authenticates with AWS SigV4
   * instead of a bearer credential. Present replaces the route's auth with a
   * per-request signer: {@link routeAuth} hands the SDK a placeholder key so it
   * constructs, and {@link buildProvider} wraps every request in a signing
   * `fetch` that strips that key's header and signs the exact bytes. Absent
   * keeps the bearer/`apiKeyEnv` path.
   */
  sigv4?: SigV4Config
}

/**
 * The auth one route resolves its credential through.
 *
 * A catalog route keeps the installed provider's own auth, which is what
 * preserves provider-native ambient discovery for a profile naming no
 * credential. That holds even when the profile repoints the protocol: which
 * environment a provider reads is a property of the provider, not of the wire
 * format its models speak.
 *
 * The single addition covers a catalog provider that offers no api-key method
 * at all. pi-ai resolves a request's `apiKey` override only when the provider
 * declares one (`resolveProviderAuth` checks `provider.auth.apiKey` before
 * honouring the override), so an OAuth-only provider — `openai-codex` is the
 * one the installed catalog ships — would refuse a profile's explicit key with
 * `Provider is not configured` before any request went out. Adding the harness
 * method beside the provider's own restores that route. A keyless profile adds
 * nothing and still reports the honest refusal, because this adapter resolves
 * credentials through its own seam and holds no OAuth store to fall back on.
 * @param spec - the resolved route facts.
 * @param catalog - the installed catalog provider, when pi-ai ships one.
 * @returns the auth to construct this route's provider with.
 */
function routeAuth(spec: ProviderSpec, catalog: Provider | undefined): Provider['auth'] {
  // A SigV4 route signs per request, so its provider-level auth exists only to
  // let the SDK construct: the placeholder key replaces any catalog auth and
  // the signing fetch strips the header it produces.
  if (spec.sigv4 !== undefined) return { apiKey: sigv4ApiKeyAuth(spec.displayName) }
  if (catalog === undefined) return { apiKey: harnessApiKeyAuth(spec.displayName) }
  if (catalog.auth.apiKey !== undefined || !spec.namesCredential) return catalog.auth
  return { ...catalog.auth, apiKey: harnessApiKeyAuth(spec.displayName) }
}

/**
 * Reuse an installed catalog provider with this route's models and identity.
 * Model dispatch stays with the catalog provider, so its API implementations,
 * compatibility quirks, and ambient credential discovery are preserved exactly.
 * Catalog-owned dynamic refresh is dropped: this route's catalog is the
 * settings document, and a background refresh would contradict it.
 */
function reuseCatalogProvider(base: Provider, spec: ProviderSpec): Provider {
  // Provider-level `baseUrl` is display metadata: pi-ai routes every request
  // through `Model.baseUrl`, which model resolution has already overridden.
  const baseUrl = spec.baseURL ?? base.baseUrl
  return {
    id: spec.provider,
    name: spec.displayName,
    ...baseUrl === undefined ? {} : { baseUrl },
    auth: routeAuth(spec, base),
    getModels: () => spec.models,
    // Delegated rather than copied: the catalog provider stays the receiver, so
    // an implementation holding state on itself keeps working.
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
}

/**
 * Wrap a provider so every request signs with SigV4. Each request method
 * injects the signing `fetch` into its options, which pi-ai passes to the SDK
 * client so it signs the final serialized request. A `fetch` a caller supplied
 * is replaced: this route must sign, and its transport is the signer's alone.
 * @param provider - the provider whose requests must be SigV4-signed.
 * @param config - the SigV4 service and region to sign under.
 * @returns a provider whose stream and deferred requests are SigV4-signed.
 */
function withSigV4Fetch(provider: Provider, config: SigV4Config): Provider {
  const fetch = createSigV4Fetch(config)
  // Every option type here has only optional fields, so injecting `fetch`
  // preserves the caller's option type; the cast states that to the compiler,
  // which a spread of an optional value otherwise widens.
  const withFetch = <T extends ProviderRequestOptions>(options: T | undefined): T => ({ ...options, fetch }) as T
  const fetchDeferred = provider.fetchDeferred
  const cancelDeferred = provider.cancelDeferred
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, withFetch(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, withFetch(options)),
    ...fetchDeferred === undefined ? {} : {
      fetchDeferred: (model, handle, options) => fetchDeferred.call(provider, model, handle, withFetch(options)),
    },
    ...cancelDeferred === undefined ? {} : {
      cancelDeferred: (model, handle, options) => cancelDeferred.call(provider, model, handle, withFetch(options)),
    },
  }
}

/**
 * Build the pi-ai provider for one resolved route.
 * @param spec - the resolved route facts.
 * @returns the provider to register in the adapter's `Models` collection.
 * @throws Error when the route names a wire protocol this build cannot serve.
 */
export function buildProvider(spec: ProviderSpec): Provider {
  const provider = buildBaseProvider(spec)
  return spec.sigv4 === undefined ? provider : withSigV4Fetch(provider, spec.sigv4)
}

/** Construct the route's provider before any SigV4 wrapping. */
function buildBaseProvider(spec: ProviderSpec): Provider {
  const catalog = catalogProvider(spec.provider)
  // A catalog route keeping its catalog protocol reuses the catalog provider;
  // an explicit protocol means the deployment is repointing the route at a
  // different wire format, which only the protocol table can serve.
  if (catalog !== undefined && spec.api === undefined) return reuseCatalogProvider(catalog, spec)

  // Every model on this path carries the route's protocol: model resolution
  // requires one for a route the catalog cannot default, and an explicit one
  // replaces each catalog model's own. So the route has a single API.
  const factory = spec.api === undefined ? undefined : PROTOCOLS[spec.api]
  if (factory === undefined) {
    throw new Error(
      `llm-pi-ai: provider "${spec.provider}" names api "${spec.api}", which this build cannot serve;`
      + ` supported protocols are ${supportedProtocols().join(', ')}`,
    )
  }
  return createProvider({
    id: spec.provider,
    name: spec.displayName,
    ...spec.baseURL === undefined ? {} : { baseUrl: spec.baseURL },
    auth: routeAuth(spec, catalog),
    models: spec.models,
    api: factory(),
  })
}
