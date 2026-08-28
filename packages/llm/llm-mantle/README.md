# @deepseek-ai/dsh-llm-mantle

SigV4-signed [Bedrock Mantle](https://bedrock-mantle.us-east-1.api.aws) adapter for the harness LLM seam. It reuses `@earendil-works/pi-ai` for `anthropic-messages` and `openai-responses` wire serialization, and signs every request with AWS SigV4 from the ambient credential chain — no api-key, no `apiKeyEnv`, and no bearer on the wire.

This package owns two provider routes, `mantle-claude` (anthropic-messages) and `mantle-gpt` (openai-responses), deliberately distinct from pi-ai's catalog names so a composition may mount it beside `@deepseek-ai/dsh-llm-pi-ai`. It depends on `@earendil-works/pi-ai@^0.84.2`, the same version the workspace runs, so pnpm resolves one shared pi-ai copy and no existing package changes.

The package root exposes the Cordis plugin contract and `MantleAdapter`; the SigV4 fetch, provider/model construction, and chunk translation helpers are exported for tests but are not part of the seam contract.

## Config

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-mantle'
  config:
    region: us-east-1        # optional; AWS region for the SigV4 scope and the bedrock-mantle.{region}.api.aws host
    maxTokens: 8192          # optional positive per-request output cap; this is the default. An explicit request value wins
    contextWindow: 200000    # optional advertised capacity for both routes; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    retryPolicy:             # optional; omission uses normal mode with its default retries
      mode: always           # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
```

The plugin registers two routes at load: `mantle-claude` → model `anthropic.claude-opus-4-8` over `https://bedrock-mantle.{region}.api.aws/anthropic`, and `mantle-gpt` → model `openai.gpt-5.6-sol` over `https://bedrock-mantle.{region}.api.aws/openai/v1`. The model ids and endpoints are the gateway's own catalog — an external spec, not a deployment choice — so they are fixed; the region is the one endpoint knob. A request selects a route with `provider: mantle-claude` or `provider: mantle-gpt`; its `model` must be the route's model id. Both routes share the resolved `retryPolicy`, reported through `ctx.llm.providerRetryPolicy(...)`. Registering another adapter for either route throws `LlmError('DUPLICATE_ADAPTER')`.

## Authentication

There is no credential configuration. A single per-adapter signing `fetch` draws short-lived credentials from the AWS SDK default provider chain (`@aws-sdk/credential-provider-node`) — SSO, instance role, or exported keys — and SigV4-signs every request under service `bedrock-mantle` and the configured region, so credentials refresh from the ambient session with no minted token stored anywhere. pi-ai's SDK client still constructs with a placeholder api-key so it does not read an ambient key or refuse to build; the signing fetch strips the `authorization`/`x-api-key` header that placeholder produces before signing, so it never reaches the network. The composition must run where that chain resolves credentials permitted to invoke `bedrock-mantle`.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()` — the mandatory `User-Agent` baseline identifying the harness (see [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts)). Because SigV4 leaves `User-Agent` unsigned by default, the signing fetch names the attribution header(s) in `signableHeaders`, folding them into the signature so `user-agent` appears inside the request's `SignedHeaders` and the gateway cannot rewrite it without invalidating the signature.

## Errors

pi-ai reports failures as terminal stream events, mapped into harness finish chunks with stable codes: `AUTH` (401/403), `QUOTA` (exhausted quota/credits), `RATE_LIMIT` (other 429s), `CONTEXT_WINDOW_EXCEEDED` (usage-based or message overflow), `INVALID_REQUEST` (400/413), `SERVER` (5xx), `TIMEOUT`, `TRANSPORT` (mid-stream socket/connection drops), otherwise `PI_AI_ERROR`. A completed `stop` that opened no content blocks becomes a `finish {kind: 'error'}` with code `EMPTY_RESPONSE`. A source stream that ends without a terminal event throws `LlmError('STREAM_CLOSED')`. `streamIdleTimeoutMs` bounds each outstanding provider read (including the initial connection); expiry throws `LlmError('TIMEOUT')`, while an earlier caller abort throws `LlmError('ABORTED')`.

## Model Experience

### Mantle request

#### What the model sees

The selected model receives the harness system prompt (mapped to pi-ai's single `systemPrompt` slot), text message history, tool schemas, and call config. Assistant history is reconstructed from durable harness content; adapter-owned replay metadata (ids and signatures) restores native fidelity when it matches, and degrades to provider-neutral content otherwise. Tool-result names are recovered from the preceding assistant tool calls.

#### Token effect

Provider tokenization governs exact input. Replay passback carries prior assistant turns (including reasoning signatures the provider returned) into later requests; cache-read usage is reported when the provider returns it.

#### KV Cache effect

An unchanged assembled prefix is eligible for provider cache reuse, which the adapter reports in usage. A route change or any upstream prompt, schema, prefix, or history change may prevent reuse from the first changed token.

### Mantle response

#### What the model sees

Text, reasoning, and raw-string tool arguments are translated into harness chunks for the loop to log and assemble; pi-ai's parsed tool arguments are re-serialized to the raw JSON string the harness vocabulary keeps.

#### Token effect

Generated tokens follow the request's `maxTokens`; only loop-retained blocks affect later input.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix. Changing the route selects a different cache domain.

## Known Limitations and Deferred Work

- **Image input is not supported** — both routes advertise `text` only, and an image content block in any message fails with `UNSUPPORTED_CONTENT`. The gateway models accept images; wiring the durable attachment projection (as the pi-ai and DeepSeek adapters do) is deferred.
- **No reasoning-effort control** — the routes carry no reasoning metadata (`reasoning: false`), so no `off`/`low`/`high`/`max` efforts are offered; the provider's own default thinking applies.
- **Configuration resolves once at load** — a region or cap change requires a restart; there is no `ctx.settings` section or configurable-provider directory entry yet, unlike the DeepSeek and pi-ai adapters.
- **Region is the only endpoint knob** — model ids and endpoint paths are fixed to the Mantle catalog; a route repoint would need config surface these constants do not expose.
- **Cost is reported as zero** — billing is settled by the AWS account behind the gateway, so the model descriptors carry no per-token price table.
- **Bilingual `README.zh.md` pairing is pending** — the Chinese translation is produced by the repo's explicitly-invoked `dsh-translate-docs` step, not authored here.
