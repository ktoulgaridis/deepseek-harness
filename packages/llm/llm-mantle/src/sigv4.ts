/**
 * AWS SigV4 request signing for the Bedrock Mantle gateway, reached over the
 * `anthropic-messages` and `openai-responses` wire protocols. The gateway
 * authenticates with SigV4 rather than a bearer credential.
 *
 * The seam pi-ai exposes is a per-request `fetch`: the Anthropic and OpenAI SDK
 * clients call it with the final serialized URL, headers, and body, which is
 * exactly what SigV4 must sign. {@link createSigV4Fetch} returns such a `fetch`
 * that signs every request with credentials from the AWS SDK default provider
 * chain, so a role's short-lived credentials refresh from the ambient SSO or
 * instance session with no minted token stored anywhere. Each call is signed
 * independently, so two requests carry distinct `x-amz-date` values and
 * distinct signatures.
 *
 * The SDK still constructs with an api-key (it refuses to build without one and
 * would otherwise read an ambient key), so it sets its own `authorization` or
 * `x-api-key` header; the signing fetch strips those before signing and sends
 * only the SigV4 `Authorization` header. The placeholder key never leaves the
 * process.
 *
 * The app-attribution header names are force-signed: SigV4 leaves `user-agent`
 * unsigned by default, so without this the mandatory attribution header would
 * ride outside `SignedHeaders` and the gateway could rewrite it undetected.
 * Naming them in `signableHeaders` folds them into the signature.
 *
 * @module @deepseek-ai/dsh-llm-mantle/sigv4
 */

import { Sha256 } from '@aws-crypto/sha256-js'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { SignatureV4 } from '@smithy/signature-v4'
import type { HttpRequest, QueryParameterBag } from '@smithy/types'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/** SigV4 signing parameters for one provider route. */
export interface SigV4Config {
  /** SigV4 service name signed into the credential scope (Bedrock Mantle: `bedrock-mantle`). */
  service: string
  /** AWS region signed into the credential scope. */
  region: string
}

/**
 * Placeholder api-key handed to the provider SDK so it constructs a client
 * without reading an ambient key or refusing to build. The SDK derives an
 * `authorization` or `x-api-key` header from it, which {@link createSigV4Fetch}
 * strips before signing, so this value never reaches the network. It must not
 * look like an OAuth token, or pi-ai's Anthropic client would take its
 * bearer-auth path instead of the header-owned one.
 */
export const SIGV4_PLACEHOLDER_KEY = 'sigv4'

/**
 * Request headers a provider SDK derives from its api-key, removed before
 * signing so the only credential on the wire is the SigV4 `Authorization`
 * header. Matched case-insensitively.
 */
const STRIPPED_AUTH_HEADERS: ReadonlySet<string> = new Set(['authorization', 'x-api-key'])

/**
 * Header names folded into the SigV4 signature even though the signer would
 * otherwise skip them. The mandatory app-attribution headers are here so the
 * gateway cannot rewrite them without invalidating the signature; the names are
 * the exact keys {@link attributionHeaders} emits, lowercased for the
 * case-insensitive match.
 */
const SIGNABLE_ATTRIBUTION_HEADERS: ReadonlySet<string> = new Set(
  Object.keys(attributionHeaders()).map(name => name.toLowerCase()),
)

/** Collect a URL's query into the bag SignatureV4 canonicalizes, preserving repeated keys. */
function toQuery(searchParams: URLSearchParams): QueryParameterBag {
  const query: QueryParameterBag = {}
  for (const key of new Set(searchParams.keys())) {
    // `key` came from the URL's own keys, so getAll returns at least one value.
    const values = searchParams.getAll(key)
    query[key] = values.length > 1 ? values : (values[0] ?? '')
  }
  return query
}

/**
 * Build a `fetch` that SigV4-signs every request before delegating to
 * `globalThis.fetch`. The signer holds an auto-refreshing credential provider,
 * so a long session re-signs with credentials the ambient AWS session renews;
 * nothing is cached across the process's own life beyond that provider.
 * @param config - the SigV4 service and region to sign under.
 * @returns a `fetch` suitable for a pi-ai provider request's `fetch` option.
 */
export function createSigV4Fetch(config: SigV4Config): typeof globalThis.fetch {
  const signer = new SignatureV4({
    service: config.service,
    region: config.region,
    credentials: defaultProvider(),
    sha256: Sha256,
  })
  return async (input, init) => {
    // One normalized request carries the SDK's final method, merged headers, and
    // body regardless of whether it arrived as (url, init) or a Request; the
    // body is buffered once so the exact bytes are both signed and resent.
    const request = new Request(input as RequestInfo | URL, init)
    const url = new URL(request.url)
    const body = request.body === null ? undefined : new Uint8Array(await request.clone().arrayBuffer())
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => {
      if (!STRIPPED_AUTH_HEADERS.has(name.toLowerCase())) headers[name] = value
    })
    headers.host = url.host
    const signable: HttpRequest = {
      method: request.method,
      protocol: url.protocol,
      hostname: url.hostname,
      ...url.port === '' ? {} : { port: Number(url.port) },
      path: url.pathname,
      query: toQuery(url.searchParams),
      headers,
      ...body === undefined ? {} : { body },
    }
    const signed = await signer.sign(signable, { signableHeaders: new Set(SIGNABLE_ATTRIBUTION_HEADERS) })
    return globalThis.fetch(url, {
      method: request.method,
      headers: signed.headers,
      ...body === undefined ? {} : { body },
      signal: request.signal,
    })
  }
}
