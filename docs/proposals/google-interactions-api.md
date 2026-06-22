# Proposal: Google Gemini via the Interactions API

**Status:** Proposal (research + migration plan; no handler code yet)
**Owner:** _unassigned_
**Tracking branch:** `claude/interactions-api-ga-28j8yu`
**Companion proposal:** [`openai-responses-api.md`](./openai-responses-api.md) — the directly analogous "provider ships a new stateful, server-side-state API" precedent that this design mirrors.

> **Verification note.** The Interactions API reached general availability after
> this author's training cutoff. The schema below is reconstructed from Google's
> public announcement, the GA docs index, and the `@google/genai` JS SDK surface
> as surfaced through web search — Google's `ai.google.dev` doc pages returned
> HTTP 403 to automated fetches, so **exact field casing and step-type names were
> not byte-verified against the live reference.** Every place where the precise
> identifier matters is flagged `⚠️ verify`. Before writing handler code, walk
> the [Verification checklist](#verification-checklist) against the installed SDK
> `.d.ts` and the live docs (the way `openai-responses-api.md` and the Copilot
> PRD were verified against pinned types).

## Summary

Google has made the **Interactions API** (`client.interactions.create(...)`) the
**primary, recommended interface** for Gemini models *and* agents, GA as of the
2026 announcement. It is a single stateful endpoint that replaces the
`generateContent` / chat surface for new work: server-side conversation state
(continue by referencing a prior interaction id instead of resending history),
background/async execution, a unified **steps**-based response model, mixing
built-in tools (Google Search, Maps) with custom functions in one request, tool
results that can return images, and new media-generation and managed-agent
capabilities. `generateContent` remains supported, but Google states frontier
long-running/agentic capabilities will increasingly land **only** on Interactions.

TeXRA today drives Gemini exclusively through the **chat / `generateContent`**
surface of the same SDK (`@google/genai`). This proposal recommends an
**additive, feature-flagged** Interactions handler that lives beside the existing
one — exactly the shape TeXRA already uses for OpenAI's Responses API — rather
than an in-place rewrite. That keeps the battle-tested `generateContent` path as
the default/fallback while we gain access to Interactions-only features, and lets
us flip the default per-model once the new path is proven.

## Motivation

- **Future-proofing.** Google has declared Interactions the default across AI
  Studio, the Gemini API, and all docs; new frontier agentic/long-running
  features are expected to be Interactions-only. Staying on `generateContent`
  means those features become unreachable from TexRA over time.
- **Server-side state.** Continuing via a prior-interaction id (instead of
  resending the full `Content[]` history every round) shrinks request payloads
  and simplifies multi-turn management — the same win TeXRA already realised for
  OpenAI via `previous_response_id` (see `openai-responses-api.md`).
- **Background execution.** `background: true` for long-running runs maps
  naturally onto TeXRA's existing background-response machinery
  (`texra.model.useBackgroundResponses`, already wired for OpenAI).
- **Unified tool model.** Mixing built-in tools (Google Search) with custom
  function declarations in a single request directly removes a limitation TeXRA
  documents today: the native `googleSearch` tool is currently disabled because
  the `generateContent` API cannot combine `googleSearch` with
  `functionDeclarations` (see `modelHandlerGoogleGenAI.ts:355`).
- **Same SDK.** This rides on the already-installed `@google/genai` dependency —
  no new vendor SDK, consistent with the existing provider boundary.

## Current state (verified in repo)

TeXRA's Gemini integration is a single, mature handler on the chat surface:

| File | Detail |
| ---- | ------ |
| `src/agent/modelHandlers/google/modelHandlerGoogleGenAI.ts` (~1366 lines) | `ModelHandlerGoogleGenAI`; calls `client.chats.create()` → `chat.sendMessageStream()` / `chat.sendMessage()`; `client.models.countTokens()`; `client.files.upload()` |
| `src/agent/modelHandlers/google/googleMessageHelpers.ts` | Strict user/model alternation, `systemInstruction`, parts-based `Content[]` construction |
| `src/agent/modelHandlers/google/googleUsage.ts` | Token/price/usage normalization from `GenerateContentResponseUsageMetadata` |
| `src/agent/modelHandlers/google/googleSdkError.ts` | Maps `GoogleApiError` → TeXRA SDK error kinds |
| `src/agent/modelHandlers/toolConversion.ts:360` | `toGoogleTools()` → `{ functionDeclarations }` |
| `src/agent/runtime/ModelFactory.ts:73` | `PROVIDER_HANDLER_ROUTES[ModelProvider.GOOGLE]` → loads `ModelHandlerGoogleGenAI`, compatibility key `'ModelHandlerGoogleGenAI'` |
| `package.json:108`, `packages/extension/package.json:1713` | `@google/genai` `^2.9.0` |

Notable capabilities the new handler must preserve (all currently in
`modelHandlerGoogleGenAI.ts`):

- **Streaming** with thinking/output separation and end-of-stream usage capture.
- **Parallel tool calls batched into one model message**, preserving Gemini 3
  **thought signatures** (`requiresBatchedParallelToolResults = true`, line 346;
  thought-signature plumbing on `GoogleToolCall`). This is the highest-risk area
  to reproduce on a new wire format.
- **Multimodal**: inline base64 (≤20 MB) vs File API upload (>20 MB), Gemini 3
  media-resolution levels.
- **Thinking levels** (`LOW`/`MEDIUM`/`HIGH`) via `thinkingConfig`.
- **Native token counting** (`countTokens`) feeding context-window guards.
- **Usage/pricing**: input/output/reasoning/cached/tool-use token breakdown and
  cache rebate.

There are **no** existing references to the Interactions API in the repo.

## The precedent this mirrors: OpenAI Responses API

TeXRA already solved the "provider introduced a newer, stateful, server-side-state
API alongside the legacy one" problem for OpenAI. The wiring we should copy:

- A **separate handler** `ModelHandlerOpenAIResponse`
  (`src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts`) coexists with
  the chat-completions handler.
- A **compatibility key** `'ModelHandlerOpenAIResponse'` in
  `ModelHandlerCompatibilityKey` (`ModelFactory.ts:29`) marks the distinct
  conversation-history format, so history restoration/compaction know which
  shape a saved run used.
- A **routing predicate** `shouldUseResponsesAPI(config, useOpenRouter)`
  (`ModelFactory.ts:175`) decides per-model whether to use the new path, gated by
  the setting `texra.model.useOpenAIResponsesAPI` (plus per-model `required` and
  `gpt-oss` forcing).
- A **settings flag** `model.useOpenAIResponsesAPI` in
  `src/shared/schemas/coreSettings.ts` (default `true`; lines 81, 325, 564) with
  a companion `model.useBackgroundResponses`.
- `createModelHandler()` branches to the Responses handler **before** the
  default provider route (`ModelFactory.ts:361`).

This proposal reuses that exact pattern for Google.

## API surface (reconstructed — see verification note)

Authoritative source for code will be the **installed `@google/genai` `.d.ts`**;
the following is the working model.

**Request — `client.interactions.create(params)`** (and a streaming variant):

- `model` *or* `agent` — exactly one. `model` for inference (e.g.
  `gemini-3.5-flash` ⚠️ verify ids), `agent` for managed agents
  (`antigravity-preview-*`, `deep-research-*`).
- `input` — text string, or multimodal/array input (parts: text + inline data +
  file refs). ⚠️ verify the part object shape vs the chat API's `Part`.
- `previous_interaction_id` — continue a prior interaction (server-side state).
  ⚠️ verify exact key (`previousInteractionId` in camelCase SDK vs
  `previous_interaction_id` in REST).
- `background: boolean` — async/server-side execution.
- `stream: boolean` (or a dedicated `createStream`/SSE iterator) ⚠️ verify which.
- `tools` — array mixing custom functions
  (`{ type: 'function', name, description, parameters }`) and built-ins
  (`{ type: 'google_search' }`, `{ type: 'code_execution' }`, Maps). ⚠️ verify
  exact tool object discriminator and whether function shape is `parameters`
  (JSON Schema) like the reconstructed form, or nested `functionDeclarations` as
  in the chat API.
- `environment` — `'remote'` for managed-agent sandboxes.
- generation knobs / `system_instruction` / structured-output `response_format`
  (a polymorphic format that replaced `response_mime_type`) ⚠️ verify, plus
  `thinking`/reasoning config and `response_modalities` for media generation.
- service tier: **Flex** (≈50% cost) vs **Priority** (latency). ⚠️ verify key.

**Response — the `Interaction` resource:**

- A chronological **`steps`** array; each step is a typed object —
  `user_input`, `thought`, `function_call`, function result/`model_output`, text
  output, etc. ⚠️ verify the exact set and names. This is the schema's headline
  change ("From Roles to Steps"): every action is its own typed step rather than
  a role-tagged message with parts.
- Convenience accessors on the `Interaction` for the common cases (e.g. final
  text) without walking `steps`. ⚠️ verify accessor names.
- An interaction `id` (for `previous_interaction_id` continuation), and usage /
  token metadata. ⚠️ verify usage field names — likely differ from
  `GenerateContentResponseUsageMetadata` (`promptTokenCount`, `candidatesTokenCount`,
  `thoughtsTokenCount`, `cachedContentTokenCount`, `toolUsePromptTokenCount`).
- **Streaming** emits SSE-style events with types such as `step.start` /
  `step.delta` (text chunks under `delta`) / step completion. ⚠️ verify event
  and field names.
- **Retention:** past interactions retrievable, ~55-day retention on paid tier.

**Schema volatility (important).** Search surfaced that the Interactions schema
churned during beta: the **steps** array replaced an earlier `outputs` shape, and
a polymorphic `response_format` replaced `response_mime_type`, with the legacy
shape removed mid-2026. GA means the schema is now stable, but it strongly argues
for (a) pinning a known-good `@google/genai` version and (b) keeping the legacy
`generateContent` handler as fallback.

## Mapping: `generateContent`/chat → Interactions

| TeXRA concern | Today (`generateContent`/chat) | Interactions API |
| ------------- | ------------------------------ | ---------------- |
| Send a turn | `chat.sendMessage(parts)` | `interactions.create({ model, input })` |
| Streaming | `chat.sendMessageStream()` → `chunk.candidates[0].content.parts` | stream events → `step.delta` text ⚠️ |
| Conversation state | resend full `Content[]` each round | `previous_interaction_id` (server-side) ⚠️ |
| System prompt | `systemInstruction` on chat params | `system_instruction` on create ⚠️ |
| Custom tools | `{ functionDeclarations: [...] }` | `tools: [{ type:'function', name, description, parameters }]` ⚠️ |
| Built-in search | **disabled** (can't mix with functions) | `tools: [{ type:'google_search' }, ...functions]` — now mixable |
| Tool call out | `functionCall` part on candidate | `function_call` step (`name`, args, id) ⚠️ |
| Tool result in | `functionResponse` part (user msg) | function-result step ⚠️ |
| **Parallel tool calls** | batched into one model `Content` + thought signatures | must map onto steps **without losing thought signatures** ⚠️ **highest risk** |
| Thinking | `thinkingConfig` + `thought` parts | reasoning/thinking config + `thought` steps ⚠️ |
| Multimodal in | inline base64 / File API `uri` parts | inline data / file refs in `input` ⚠️ |
| Token counting | `client.models.countTokens()` | unchanged `countTokens` (still on `models`)? ⚠️ verify |
| Usage/pricing | `GenerateContentResponseUsageMetadata` | new usage metadata shape ⚠️ remap `googleUsage.ts` |
| Background | n/a for Google today | `background: true` (reuse `useBackgroundResponses` machinery) |
| Caching | `cachedContentTokenCount` rebate | verify cache reporting on the new usage shape ⚠️ |

## Design (additive, feature-flagged)

Mirror the OpenAI Responses precedent end to end.

### 1. New handler

`ModelHandlerGoogleInteractions` in
`src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts`, extending the
shared `ModelHandler` base like the existing Google handler. Reuse what is
provider-shaped rather than wire-shaped:

- **Reuse** `googleSdkError.ts` (same SDK error type), tool **schema conversion**
  helpers in `toolConversion.ts` (JSON-Schema flattening/`$schema` stripping is
  wire-agnostic), and the media upload size/threshold logic.
- **Rewrite** message construction (`googleMessageHelpers.ts` equivalent) for the
  steps model + `previous_interaction_id`, the streaming loop (step events), tool
  call extraction/round-trip, and `googleUsage.ts` for the new usage metadata.
- Keep **thought-signature preservation** for parallel tool calls as a
  first-class requirement and cover it with a dedicated test (it is the single
  most likely regression).

### 2. Compatibility key

Add `'ModelHandlerGoogleInteractions'` to the `ModelHandlerCompatibilityKey`
union (`ModelFactory.ts:29`). Because Interactions stores conversation state
**server-side** and continues via `previous_interaction_id`, its persisted
history shape differs from the chat handler's `Content[]` — history
restoration/compaction must not mix the two. A distinct key is mandatory.

### 3. Routing predicate + factory branch

Add `shouldUseGoogleInteractionsAPI(config, useOpenRouter)` next to
`shouldUseResponsesAPI` (`ModelFactory.ts`). Gate on a new setting plus a
per-model `requiresInteractionsAPI`/agent flag (agents like `antigravity-*` /
`deep-research-*` are Interactions-only and would force it). Branch to the new
handler in `createModelHandler()` **before** the default Google provider route
(`PROVIDER_HANDLER_ROUTES[GOOGLE]`), exactly as the Responses branch precedes the
default OpenAI route. Respect `useOpenRouter` (OpenRouter cannot proxy
Interactions — fall back to the existing path), the same guard
`requiresOpenAIResponsesAPI` applies.

### 4. Settings

Add `model.useGoogleInteractionsAPI` to `src/shared/schemas/coreSettings.ts`
(default, key list, and Zod schema — the three sites at lines ~81/325/564),
mirroring `useOpenAIResponsesAPI`. Reuse `model.useBackgroundResponses` for the
`background: true` behaviour, or add a Google-specific companion if semantics
diverge. Surface the toggle in Settings → Models and document in
`docs/guide/configuration.md`.

### 5. Model registry

Register the new Gemini model ids / agent ids surfaced at GA (e.g.
`gemini-3.5-flash`, Antigravity / Deep Research agents) in the model
configuration source (`llm-zoo` `MODEL_CONFIGS` + `src/model/` capability/pricing
mapping), marking agent-only entries with the Interactions-required flag. ⚠️
verify the exact ids and pricing at implementation time.

## Platform / VS Code separation

No new host coupling. `src/agent/modelHandlers/` is a VS Code-free zone and the
new handler stays there, reaching host services only through `platform()`
(secrets for the API key via `getApiKey(secrets, 'google')`, config, fs for media
upload) — identical to the existing Google handler. The settings toggle flows
through the existing `coreSettings` schema; no new ports needed.

## Risks & open questions

1. **Unverified schema (post-cutoff).** Everything marked ⚠️ must be confirmed
   against the installed `.d.ts` and live docs before coding. Treat the table
   above as a hypothesis, not a contract.
2. **Thought-signature preservation across the steps model.** Gemini 3 parallel
   tool calling depends on round-tripping thought signatures; the steps schema
   reorganises how calls/results are represented. This is the most likely place
   to silently break parallel tool use. Needs an explicit fixture test.
3. **Schema churn / version pinning.** The beta schema changed materially
   (`outputs`→`steps`, `response_mime_type`→`response_format`). Pin a known-good
   `@google/genai` (current dep is `^2.9.0` — confirm it actually exposes
   `interactions`; the search-surfaced "introduced in 1.33.0" is unverified).
4. **Server-side state + history/compaction.** TeXRA's history restore and
   context compaction assume a resend-able local transcript. With
   `previous_interaction_id` the canonical state lives on Google's servers with a
   ~55-day retention. Decide whether to (a) keep sending full local history
   (stateless mode, simplest, loses the payload win) or (b) adopt
   `previous_interaction_id` and define behaviour when the server-side
   interaction has expired / when a run is restored from old history. The OpenAI
   Responses handler already faced this — reuse its resolution.
5. **OpenRouter interaction.** Interactions is Google-direct only; ensure the
   `useOpenRouter` path is excluded (as Responses excludes it).
6. **Usage/pricing remap.** New usage metadata field names → `googleUsage.ts`
   must be re-derived; cache-token rebate and reasoning-token accounting need
   re-validation against the new shape.
7. **Managed agents are a different product surface.** `agent=` + `environment:
   'remote'` provisions a remote sandbox that browses/executes code. That is a
   much larger feature than "call a model" and should be **out of scope for v0**
   (model-mode only); track separately.
8. **Built-in tools + custom functions mixing** removes the current
   `googleSearch` limitation — but verify tool-result image return interacts
   correctly with TeXRA's tool-result attachment plumbing.

## Scope

**In (v0):** research verification; `ModelHandlerGoogleInteractions` in **model
mode** (text + multimodal in, streaming, custom function calling incl. parallel
calls with thought signatures, thinking, token counting, usage/pricing);
compatibility key; routing predicate + factory branch; `useGoogleInteractionsAPI`
setting + Settings UI + docs; tests (streaming, parallel-tool thought
signatures, usage mapping, routing); keep `generateContent` handler as default
fallback.

**Out (v0):** managed agents (`agent=`, `environment:'remote'`); media
generation (`response_modalities`, Nano Banana / Lyria / TTS); Deep Research
agent integration; making Interactions the **default** for Gemini (ship behind
the flag first, flip later); OpenRouter support for Interactions.

## Milestones

1. **Verify** the schema against the installed SDK `.d.ts` + live docs; fill in
   every ⚠️; confirm `@google/genai` version exposing `interactions` and pin it.
   Update this proposal's tables to the verified shapes.
2. `ModelHandlerGoogleInteractions` (model mode) with streaming + custom tools;
   compatibility key; factory routing behind `useGoogleInteractionsAPI` (default
   **off**). Unit tests on message/tool/usage translation (host-neutral, mocked
   SDK), explicitly including parallel-tool thought-signature round-trip.
3. Multimodal input, thinking levels, token counting, cache/usage parity; mixed
   built-in `google_search` + functions; settings UI + `configuration.md`.
4. Real-key smoke test; CHANGELOG entry; decide default flip per-model;
   register GA Gemini model ids/pricing.

## Verification checklist

Before writing handler code, confirm against the **installed** `@google/genai`
types and the live docs (resolve every ⚠️ above):

- [ ] `@google/genai` version that exposes `client.interactions` (and pin it).
- [ ] `interactions.create` param names & casing: `model`/`agent`, `input`,
      `previous_interaction_id`, `background`, `stream`/`createStream`, `tools`,
      `system_instruction`, `response_format`, thinking/reasoning config,
      `response_modalities`, service tier.
- [ ] `input` part object shape (text / inline data / file ref) — same as chat
      `Part` or new?
- [ ] `tools` entry shape: custom `{ type:'function', name, description,
      parameters }` vs `functionDeclarations`; built-in discriminators
      (`google_search`, `code_execution`, maps).
- [ ] `Interaction.steps` exact step types & fields (`function_call` name/args/id;
      function-result step; `thought`; text/`model_output`); convenience accessors.
- [ ] **Thought-signature** field on call/result steps for Gemini 3 parallel
      tool calling, and how to echo it back.
- [ ] Streaming event types/fields (`step.start`, `step.delta`, completion).
- [ ] Usage/token metadata field names (input/output/reasoning/cached/tool-use).
- [ ] `countTokens` availability/shape under the new surface.
- [ ] `previous_interaction_id` continuation semantics + retention/expiry
      behaviour for restored runs.

## References

- Interactions API overview: https://ai.google.dev/gemini-api/docs/interactions/interactions-overview
- API reference: https://ai.google.dev/api/interactions-api
- Quickstart: https://ai.google.dev/gemini-api/docs/interactions/quickstart
- Function calling: https://ai.google.dev/gemini-api/docs/interactions/function-calling
- Streaming: https://ai.google.dev/gemini-api/docs/interactions/streaming
- Migration (generateContent → Interactions): https://ai.google.dev/gemini-api/docs/interactions
- Google announcement: https://blog.google/innovation-and-ai/technology/developers-tools/interactions-api/
- JS SDK: https://github.com/googleapis/js-genai · https://www.npmjs.com/package/@google/genai
- Community quickstart (Phil Schmid): https://www.philschmid.de/interactions-api-quickstart
- TeXRA precedent: [`openai-responses-api.md`](./openai-responses-api.md);
  routing in `src/agent/runtime/ModelFactory.ts:175`; settings in
  `src/shared/schemas/coreSettings.ts`.

> _All `ai.google.dev` pages returned HTTP 403 to automated fetch during
> research; the links are for human verification of the ⚠️ items._
