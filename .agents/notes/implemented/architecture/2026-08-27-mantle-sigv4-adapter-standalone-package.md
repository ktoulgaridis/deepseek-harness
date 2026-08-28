# Agent Note: Bedrock Mantle SigV4 adapter as a standalone package on the workspace pi-ai version

Status: implemented

## Problem

Bedrock Mantle fronts Claude and GPT models behind an AWS gateway that authenticates with SigV4, not a bearer token, and serves two wire shapes split by model (`anthropic-messages` under `/anthropic`, `openai-responses` under `/openai/v1`). The harness needs a route to those models with credentials drawn from the ambient AWS chain and no minted token stored anywhere.

`@earendil-works/pi-ai` already serializes both wire shapes and exposes a per-request `fetch` seam, so reusing it is far less code than hand-rolling two serializers. The Mantle model catalog (`anthropic.claude-opus-4-8`, `openai.gpt-5.6-sol`) and the compat fields the request path needs live in pi-ai `0.84.x`, which is the version the workspace runs: `@deepseek-ai/dsh-llm-pi-ai` depends on `@earendil-works/pi-ai@^0.84.2`.

## Decision

Bedrock Mantle is a **new standalone package**, `@deepseek-ai/dsh-llm-mantle`, that touches no existing package. It registers two `LlmAdapter` routes on `ctx.llm` — `mantle-claude` (anthropic-messages) and `mantle-gpt` (openai-responses) — modeled on the standalone `dsh-llm-deepseek` rather than extending `dsh-llm-pi-ai`.

The package depends on `@earendil-works/pi-ai@^0.84.2`, the same range `dsh-llm-pi-ai` uses, so pnpm resolves one shared pi-ai copy across the workspace. No `minimumReleaseAgeExclude` entry is added for it: `0.84.2` is already excluded for `dsh-llm-pi-ai`.

The adapter reuses pi-ai's serialization through `createProvider({ api, models, auth, baseUrl })` + `createModels().streamSimple(model, ctx, { fetch })`. SigV4 signing rides the per-request `fetch` option — no provider wrapper — via `@smithy/signature-v4` + `@aws-crypto/sha256-js` + `@aws-sdk/credential-provider-node` `defaultProvider()`. The signer strips the placeholder api-key's `authorization`/`x-api-key` header before signing and buffers the body to sign exact bytes. The DeepSeek↔pi-ai request/response translation (`context.ts`, `stream.ts`, `replay.ts`) is ported from `dsh-llm-pi-ai` rather than imported, so the package does not couple to another adapter's internal `src/*` modules.

### Attribution inside SignedHeaders

The mandatory `attributionHeaders()` `User-Agent` is force-signed: SigV4 leaves `user-agent` unsigned by default, so the signing fetch names the attribution header keys in `signableHeaders`. The header therefore lands inside the request's `SignedHeaders`, and the gateway cannot rewrite it without invalidating the signature.

## Alternatives considered

**Bump `dsh-llm-pi-ai` and add SigV4 there.** Rejected: a fork-wide change to a shared adapter for one gateway. It changes that package's catalog drift gate and stream stop-reason handling and reshapes every pi-ai consumer's provider, when only Mantle needs SigV4.

**Direct-fetch adapter that hand-rolls both wire shapes (the `dsh-llm-deepseek` model).** Rejected: hand-writing and testing `anthropic-messages` and `openai-responses` serialization is far more code and duplicates what pi-ai already ships.

**Import `dsh-llm-pi-ai/src/*` translation helpers instead of porting them.** Rejected: those modules are that package's internals, not a public seam; importing them would couple `dsh-llm-mantle` to another adapter's private layout. Porting keeps the translation local and independently testable.

## Consequences

Bought: a proven route to both Mantle shapes (real `200` completions from `anthropic.claude-opus-4-8` and `openai.gpt-5.6-sol`, `Authorization: AWS4-HMAC-SHA256 .../bedrock-mantle/...`, `user-agent` inside `SignedHeaders`, no bearer, no `MANTLE_TOKEN`) with zero edits to any existing package and a single shared pi-ai version across the workspace.

Cost: the ported `context.ts`/`stream.ts`/`replay.ts` are a second copy of the translation logic to keep in sync with `dsh-llm-pi-ai` if the shared logic changes. The port is deliberately narrowed to text + tool-use (no image attachments) and offers no reasoning-effort control; both are recorded in the package README's Known Limitations. Configuration resolves once at load (no `ctx.settings` section yet).
