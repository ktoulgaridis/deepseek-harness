/**
 * SigV4 signing behavior: the only credential on the wire is the AWS4-HMAC-SHA256
 * Authorization header, the placeholder api-key header is stripped, the exact body
 * bytes are preserved, and the mandatory attribution `user-agent` is folded into
 * SignedHeaders (SigV4 would otherwise leave it unsigned).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { createSigV4Fetch, SIGV4_PLACEHOLDER_KEY } from '../src/sigv4.ts'

const realFetch = globalThis.fetch

beforeEach(() => {
  // Static credentials: SigV4 signing is offline, so the default provider chain
  // resolves these env values without any AWS call. AWS_PROFILE is cleared so the
  // SDK takes these env credentials rather than an ambient profile it cannot
  // resolve headlessly — the test must not depend on a live session.
  vi.stubEnv('AWS_PROFILE', '')
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE')
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
  vi.stubEnv('AWS_SESSION_TOKEN', 'FQoEXAMPLETOKEN')
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllEnvs()
})

interface Captured {
  url: string
  method: string
  headers: Headers
  body: string
}

function captureFetch(): { calls: Captured[] } {
  const calls: Captured[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const body = init?.body === undefined ? '' : Buffer.from(init.body as Uint8Array).toString('utf8')
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body })
    return new Response('{"ok":true}', { status: 200 })
  }) as typeof globalThis.fetch
  return { calls }
}

describe('createSigV4Fetch', () => {
  it('signs with SigV4, strips the placeholder key, and folds user-agent into SignedHeaders', async () => {
    const { calls } = captureFetch()
    const signed = createSigV4Fetch({ service: 'bedrock-mantle', region: 'us-east-1' })
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ model: 'anthropic.claude-opus-4-8', hi: true }))
    const request = new Request('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SIGV4_PLACEHOLDER_KEY}`,
        'x-api-key': SIGV4_PLACEHOLDER_KEY,
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: bodyBytes,
    })

    const response = await signed(request)
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    const sent = calls[0]!

    const auth = sent.headers.get('authorization') ?? ''
    expect(auth.startsWith('AWS4-HMAC-SHA256 ')).toBe(true)
    expect(auth).toContain('/us-east-1/bedrock-mantle/aws4_request')
    expect(/^Bearer /i.test(auth)).toBe(false)
    // The placeholder key never reaches the network.
    expect(sent.headers.get('x-api-key')).toBeNull()
    expect(auth).not.toContain(SIGV4_PLACEHOLDER_KEY)

    const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? ''
    for (const name of Object.keys(attributionHeaders())) {
      expect(signedHeaders.split(';')).toContain(name.toLowerCase())
    }
    expect(signedHeaders.split(';')).toContain('x-amz-content-sha256')

    // Exact request bytes are preserved.
    expect(sent.body).toBe(Buffer.from(bodyBytes).toString('utf8'))
    // A session-token credential rides as its own header, not a bearer.
    expect(sent.headers.get('x-amz-security-token')).toBeTruthy()
    expect(signedHeaders.split(';')).toContain('x-amz-security-token')
  })

  it('signs a query string and a body-less request, and produces a distinct signature per call', async () => {
    const { calls } = captureFetch()
    const signed = createSigV4Fetch({ service: 'bedrock-mantle', region: 'eu-west-2' })

    await signed('https://bedrock-mantle.eu-west-2.api.aws/anthropic/v1/models?limit=2&limit=5', { method: 'GET' })
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await signed('https://bedrock-mantle.eu-west-2.api.aws/anthropic/v1/models?limit=2&limit=5', { method: 'GET' })

    expect(calls).toHaveLength(2)
    const first = calls[0]!.headers.get('authorization') ?? ''
    const second = calls[1]!.headers.get('authorization') ?? ''
    expect(first.startsWith('AWS4-HMAC-SHA256 ')).toBe(true)
    // Distinct x-amz-date across seconds ⇒ distinct signatures.
    expect(calls[0]!.headers.get('x-amz-date')).not.toBe(calls[1]!.headers.get('x-amz-date'))
    expect(first).not.toBe(second)
  })

  it('signs a request that carries an explicit port and a single-value query key', async () => {
    const { calls } = captureFetch()
    const signed = createSigV4Fetch({ service: 'bedrock-mantle', region: 'us-east-1' })
    await signed('https://gateway.example:8443/anthropic/v1/models?limit=1', { method: 'GET' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain(':8443')
    expect((calls[0]!.headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256 ')).toBe(true)
  })
})
