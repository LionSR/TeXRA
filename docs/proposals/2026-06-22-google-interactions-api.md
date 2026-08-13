# Proposal: Google Gemini via the Interactions API

**Status:** Partially landed (2026-07-04 status sweep). The additive
`ModelHandlerGoogleInteractions` handler, server-state chaining, and background
mode now exist in code. Treat this document as the original design/evidence
record; re-verify current handler behavior before using older v0 defaults below.
**Owner:** _unassigned_
**Tracking branch:** `claude/interactions-api-ga-28j8yu`
**Companion proposal:** [`2025-06-04-openai-responses-api.md`](./2025-06-04-openai-responses-api.md) — the directly analogous "provider ships a new stateful, server-side-state API" precedent that this design mirrors.

> **Verification status.** The schema below is **verified against the installed
> `@google/genai@2.9.0` type definitions** (`node_modules/.../@google/genai/dist/genai.d.ts`)
> — the version currently resolved in `pnpm-lock.yaml`. The package manifests
> already depend on `@google/genai` at `^2.9.0` (`package.json:108` and
> `packages/extension/package.json:1713`), so **no dependency bump is required to
> start.** Google's official
> Interactions overview was reachable on 2026-06-22 and confirms GA status,
> recommended use for new projects, supported model/agent IDs, and storage
> retention. Pricing and Flex/Priority cost deltas still need implementation-time
> confirmation. Everything about the **SDK request/response shape is
> byte-verified** and cited to `genai.d.ts` line numbers.

## Summary

Google has made the **Interactions API** the primary, recommended interface for
Gemini models _and_ agents. In the SDK it is `client.interactions` →
`GeminiNextGenInteractions` (`genai.d.ts:5677`, `:4598`), with
`create` / `get` / `delete` / `cancel` methods. It is a single **stateful**
endpoint that supersedes the chat / `generateContent` surface for new work:
server-side conversation state (continue via `previous_interaction_id` instead of
resending history), background/async execution (`background`, `store`,
`webhook_config`), a unified **steps**-based response (`Interaction.steps:
Step[]`), mixing built-in tools (Google Search, Maps, code execution, URL
context, file search, MCP) with custom functions in **one** `tools` array, and
tool results that can return images.

TeXRA today drives Gemini exclusively through the chat / `generateContent`
surface of the **same** SDK (`client.chats.create()` →
`chat.sendMessageStream()`). This proposal recommends an **additive,
feature-flagged** Interactions handler beside the existing one — the exact shape
TeXRA already uses for OpenAI's Responses API — keeping the battle-tested
`generateContent` path as the default/fallback while we gain Interactions-only
features, and flipping the default per-model once proven.

## Motivation

- **Future-proofing.** Google has declared Interactions the default across AI
  Studio, the Gemini API, and docs; frontier agentic/long-running features are
  expected to be Interactions-only. Staying on `generateContent` strands those.
- **Server-side state.** `previous_interaction_id` (`genai.d.ts:2411`) continues
  a conversation without resending the full `Content[]` each round — the same
  payload win TeXRA already realised for OpenAI via `previous_response_id`. The
  v0 plan deliberately starts with `store:false` to preserve TeXRA's current
  history/compaction contract, then enables server-side continuation after
  expiry/restore behaviour is specified and tested.
- **Background execution.** `background?: boolean` (`:2389`) + `store?`
  (`:2385`) + `webhook_config?` (`:2416`) map onto TeXRA's existing
  background-response machinery (`texra.model.useBackgroundResponses`).
- **Unified tool model.** `tools?: Array<Tool>` where `Tool = FunctionT |
CodeExecution | URLContext | ComputerUse | MCPServer | GoogleSearch |
FileSearch | GoogleMaps | Retrieval` (`:12272`) — built-in **and** custom
  functions in one request. This removes the limitation TeXRA documents today:
  native `googleSearch` is disabled because the `generateContent` API cannot
  combine `googleSearch` with `functionDeclarations` (`toolConversion.ts:355-357`,
  attributed there to the Live API). Interactions exposes built-ins and custom
  functions in one `Tool` union; enable mixed requests after model-gated smoke
  tests rather than assuming every id supports every combination.
- **Tool results with images.** A `function_result` step's `result` can be
  `string | {} | Array<FunctionResultSubcontent>` where `FunctionResultSubcontent
= TextContent | ImageContent` (`:4543`,`:4553`).
- **Same SDK, same dependency.** `client.interactions` already exists on
  `GoogleGenAI`, so v0 should reuse TeXRA's credential/base URL/retry setup while
  selecting and smoke-testing the Interactions API version explicitly.

## Current state (verified in repo)

| File                                                                      | Detail                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent/modelHandlers/google/modelHandlerGoogleGenAI.ts` (~1366 lines) | `ModelHandlerGoogleGenAI`; `client.chats.create()` (`:496`) → `chat.sendMessageStream()` (`:507`) / `chat.sendMessage()` (`:617`); `client.models.countTokens()` (`:383`); `client.files.upload()` (`:245`); client built `new GoogleGenAI({ apiKey })` (`:304`,`:323`) via base `getApiKey()` (`:299`,`:319`) |
| `src/agent/modelHandlers/google/googleMessageHelpers.ts`                  | Strict user/model alternation, `systemInstruction`, parts-based `Content[]`                                                                                                                                                                                                                                    |
| `src/agent/modelHandlers/google/googleUsage.ts`                           | Token/price/usage from `GenerateContentResponseUsageMetadata`                                                                                                                                                                                                                                                  |
| `src/agent/modelHandlers/google/googleSdkError.ts`                        | `GoogleApiError` → TeXRA SDK error kinds (reusable as-is)                                                                                                                                                                                                                                                      |
| `src/agent/modelHandlers/toolConversion.ts:360`                           | `toGoogleTools()` → `[{ functionDeclarations }]` (chat shape)                                                                                                                                                                                                                                                  |
| `src/agent/runtime/ModelFactory.ts:73`                                    | `PROVIDER_HANDLER_ROUTES[GOOGLE]` → `ModelHandlerGoogleGenAI`, key `'ModelHandlerGoogleGenAI'`                                                                                                                                                                                                                 |
| `package.json:108`, `packages/extension/package.json:1713`                | `@google/genai` `^2.9.0` (resolved `2.9.0`, exposes `interactions`)                                                                                                                                                                                                                                            |

Capabilities the new handler must preserve (all in `modelHandlerGoogleGenAI.ts`):
streaming with thinking/output separation; **parallel tool calls with Gemini 3
thought signatures** (`requiresBatchedParallelToolResults`, `:346`); multimodal
(inline ≤20 MB vs File API >20 MB, media-resolution); thinking levels
(`thinkingConfig`); native token counting (`:383`); usage/pricing breakdown.

There are **no** existing references to the Interactions API in the repo.

## The precedent this mirrors: OpenAI Responses API

TeXRA already solved "provider introduced a newer, stateful, server-side-state API
alongside the legacy one" for OpenAI. Copy this wiring:

- Separate handler `ModelHandlerOpenAIResponse`
  (`src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts`) coexists with
  the chat-completions handler.
- Compatibility key `'ModelHandlerOpenAIResponse'` in `ModelHandlerCompatibilityKey`
  (`ModelFactory.ts:29`) marks the distinct conversation-history format so
  history restore/compaction know which shape a saved run used.
- Routing predicate `shouldUseResponsesAPI(config, useOpenRouter)`
  (`ModelFactory.ts:175`) decides per-model, gated by
  `texra.model.useOpenAIResponsesAPI` (plus per-model `required` / `gpt-oss`).
- Settings flag `model.useOpenAIResponsesAPI` in `coreSettings.ts`
  (default `true`; lines 81, 325, 564) with companion `model.useBackgroundResponses`.
- `createModelHandler()` branches to the Responses handler **before** the default
  provider route (`ModelFactory.ts:361`).

## API surface (verified against `@google/genai@2.9.0` `genai.d.ts`)

**Client:** `client.interactions` (`:5677`) → `GeminiNextGenInteractions` (`:4598`):

```ts
create(params: CreateModelInteractionParams… | CreateAgentInteractionParams…)
  : Promise<GoogleGenAIInteraction>                          // stream:false
  | Promise<Stream<GoogleGenAIInteractionSSEEvent>>          // stream:true   (:4602-4608)
get(id, params?)   // (:4609-4611)   delete(id, params?)   // (:4612)   cancel(id, params?)   // (:4615)
```

**Request — `CreateModelInteraction` (`:2373`)** — note **snake_case**:

| field                      | type                                                     | line |
| -------------------------- | -------------------------------------------------------- | ---- |
| `model`                    | `Model` (string id)                                      | 2377 |
| `input`                    | `InteractionsInput` (required)                           | 2442 |
| `stream?`                  | `boolean` (discriminates streaming vs not)               | 2381 |
| `store?`                   | `boolean` (persist for later retrieval)                  | 2385 |
| `background?`              | `boolean`                                                | 2389 |
| `system_instruction?`      | `string`                                                 | 2393 |
| `tools?`                   | `Array<Tool>`                                            | 2397 |
| `previous_interaction_id?` | `string` (server-side continuation)                      | 2411 |
| `response_format?`         | `ResponseFormat \| ResponseFormat[]` (structured output) | 2420 |
| `response_modalities?`     | `Array<ResponseModality>` (TEXT/IMAGE/AUDIO)             | 2401 |
| `generation_config?`       | `GenerationConfig` (temp, tokens, thinking, …)           | 2428 |
| `service_tier?`            | `ServiceTier` (Flex/Priority)                            | 2412 |
| `cached_content?`          | `string` (explicit cache handle)                         | 2438 |
| `webhook_config?`          | `WebhookConfig`                                          | 2416 |
| `environment?`             | `Environment \| string`                                  | 2424 |
| `response_mime_type?`      | `string` — **deprecated**, use `response_format`         | 2407 |

`CreateAgentInteraction` (`:1987`) swaps `model` for `agent` (`AgentOption`) +
`agent_config` (`DynamicAgentConfig | DeepResearchAgentConfig`) + `environment`.

**Input — `InteractionsInput` (`:7555`):**
`string | Array<Step> | Array<Content> | Array<Turn> | Content`, where
`Content = TextContent | ImageContent | AudioContent | DocumentContent |
VideoContent` (`:1841`). Multimodal uses **typed content objects**, not the chat
API's `Part`. Resuming a conversation client-side means passing prior `Step[]`.
In stateless mode, TeXRA must keep the `user_input` steps it sends because the
next request must include those local steps in addition to model-generated steps
returned by `interactions.create`.

**Tools — `Tool` (`:12272`):** custom = `FunctionT` (`:4565`)
`{ type:"function", name?, description?, parameters?: <JSON Schema> }`; built-ins
= `CodeExecution | URLContext | ComputerUse | MCPServer | GoogleSearch |
FileSearch | GoogleMaps | Retrieval`. (Contrast chat's `[{ functionDeclarations }]`.)

**Response — `Interaction` (`:6943`)** (the SDK wraps it as `GoogleGenAIInteraction`
with `steps: Step[]`, `:5683`): `id`, `status: InteractionStatus`, `created`,
`updated`, `model`/`agent`, `system_instruction`, `tools`, `usage?: Usage`,
`steps?: Step[]`, `previous_interaction_id`, `environment_id`, `response_format`,
`generation_config`, `agent_config`.

**Steps — `Step` (`:11664`)** (discriminated by `type`):

| step                 | shape                                                                                                               | line  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ----- |
| `UserInputStep`      | `{ type:"user_input", content?: Content[] }`                                                                        | 14035 |
| `ModelOutputStep`    | `{ type:"model_output", content?: Content[] }`                                                                      | 9235  |
| `ThoughtStep`        | `{ type:"thought", signature?: string, summary?: ThoughtSummaryContent[] }`                                         | 12112 |
| `FunctionCallStep`   | `{ type:"function_call", name: string, arguments: {}, id: string }`                                                 | 4403  |
| `FunctionResultStep` | `{ type:"function_result", name?, is_error?, call_id: string, result: string \| {} \| FunctionResultSubcontent[] }` | 4526  |
| built-in call/result | `CodeExecution*`, `GoogleSearch*`, `GoogleMaps*`, `FileSearch*`, `URLContext*`, `MCPServerTool*` Step variants      | —     |

`FunctionResultSubcontent = TextContent | ImageContent` (`:4553`) → tool results
can include images.

**Streaming — `InteractionSSEEvent` (`:7559`):**
`InteractionCreatedEvent | InteractionCompletedEvent | InteractionStatusUpdate |
ErrorEvent | StepStart | StepDelta | StepStop`. Events discriminate on
**`event_type`**: interaction lifecycle events (`"interaction.created"`
`:7100`, `"interaction.completed"` `:7078`, `"interaction.status_update"`
`:7625`, `"error"` `:3556`) and step events (`"step.start"` `:11699`,
`"step.delta"` `:11668`, `"step.stop"` `:11719`). Status changes such as
`"in_progress"` and `"requires_action"` are the `status` field on
`InteractionStatusUpdate`, not distinct `event_type` values. `StepDelta = {
event_type:"step.delta", index, delta: StepDeltaData, event_id?, metadata? }`;
`StepDeltaData` (`:11685`) includes `TextDelta`, `ArgumentsDelta` (streamed tool
args), `ThoughtSummaryDelta`, `ThoughtSignatureDelta`, `FunctionResultDelta`,
image/audio/doc deltas, …; `StepDeltaMetadata.total_usage?: Usage` (`:11690`)
carries running usage.

**Usage — `Usage` (`:13952`)** (snake_case, differs from
`GenerateContentResponseUsageMetadata`): `total_input_tokens`,
`total_cached_tokens`, `total_output_tokens`, `total_tool_use_tokens`,
`total_thought_tokens`, plus `*_by_modality: ModalityTokens[]` and a grand total.

## Surface area

### SDK surface (`@google/genai@2.9.0`)

The same `GoogleGenAI` client TeXRA already constructs exposes three lazily-built
"next-gen" getters (`genai.d.ts:5677-5679`) beside the existing
`models`/`chats`/`files`/`caches`/`live`/`batches`/… :

- `client.interactions` → `GeminiNextGenInteractions` — `create` (model/agent ×
  streaming), `get`, `delete`, `cancel`. **This is all v0 needs.**
- `client.agents` → `GeminiNextGenAgents` — `create`/`list`/`get`/`delete`
  managed agents (out of scope v0).
- `client.webhooks` → `GeminiNextGenWebhooks` — register/rotate/ping webhooks for
  `background` completion callbacks (out of scope v0; relevant if we later wire
  background runs to push instead of poll via `get`).

The `interactions` namespace (`:7367-7550`) is broad — beyond the v0 surface it
carries built-in tool steps + deltas for code execution, Google Search, Google
Maps, file search, URL context, MCP servers; `Environment`/`Network` egress
config; `ComputerUse`; `DeepResearchAgentConfig`/`DynamicAgentConfig`;
`Visualization`. v0 touches only: `CreateModelInteraction`, `InteractionsInput`,
`Content`, `FunctionT`/`GoogleSearch` tools, `Step` (`function_call` /
`function_result` / `thought` / `model_output` / `user_input`),
`InteractionSSEEvent` + deltas, and `Usage`. The rest is upside for later phases,
not work for v0.

### TeXRA implementation surface

The change is **contained and additive** — the existing Google handler is
referenced from a small, known set:

- **Code:** `ModelFactory.ts` (the one wiring point); `googleUsage.ts` and
  `utils/fileContentUtils.ts` (shared helpers, **reusable** — the latter already
  consolidates Anthropic/OpenAI/Google patterns); `modelHandlers/README.md`.
- **Tests (6):** `ModelFactoryRouting`, `ModelHandlerGoogle`,
  `ModelHandlerGoogleGenAI`, `GoogleGenAIStreamingText`, `GoogleCachePricing`,
  `EmptyPrefill` — plus `SdkErrorUtils` for the (reused) error tagging. New
  Interactions tests sit alongside these.

A new handler must satisfy the `ModelHandler` contract — **all 19 abstract
methods** (`ModelHandler.ts`) plus the protected/override hooks the Google handler
defines (`createResponseImpl`, `sdkErrorTagger`, `extractAssistantText`,
`createMediaMessage`, `supportsTokenCounting`, `requiresBatchedParallelToolResults`,
`estimateTokenCount`). They split cleanly:

- **Reusable / thin port (≈ copy):** `getClient` (same client + `getApiKey()`),
  `computePrice` / `normalizeUsage` (point at remapped `googleUsage.ts`),
  `processThinkingBlock`, `shouldContinue`, `estimateTokenCount`
  (`client.models.countTokens` unchanged), the `sdkErrorTagger` override (reuse
  `googleSdkError.ts`), media size/threshold logic, and the
  `supportsTokenCounting` / `requiresBatchedParallelToolResults` capability hooks.
- **Core rewrite (the real work):** `createResponseImpl` (`:405`) — today builds
  `chats.create()` → `sendMessageStream()` / `sendMessage()`; becomes
  `interactions.create({ …, stream })` driving the SSE `event_type` lifecycle
  (`step.start`/`step.delta`/`step.stop` → output vs `arguments_delta` vs
  thought). **Single biggest piece.**
- **Wire-format rewrites:** message build — `initializeMessages` /
  `createRoundMessages` / `createUserFollowUpMessages` / `createAssistantMessage`
  / `prependTextToUserMessage` / `addMediaToUserMessage` / `createMediaContent` /
  `createMediaMessage` (typed `Content` + `Step[]` input vs chat parts); prefill —
  `initializeOutputAndPrefill` (uses `fileContentUtils`) /
  `addContinueMessageWithoutPrefill` / `updateMessageContentWith[out]Prefill`
  (re-expressed for steps); extraction — `extractResponse` /
  `extractAssistantText` / `extractToolUse` (walk `steps` vs candidate parts);
  tool round-trip — `createToolUseFollowUpMessages` + the batched parallel variant
  (emit `function_result` steps keyed by `call_id`, round-trip `thought` steps).

That accounts for all 19 abstract methods plus the 7 overrides. So the surface is
~one new ~800-1000 line handler file mirroring the chat one, one routing
predicate, one settings field (×3 sites), and a handful of tests — no
cross-cutting refactor, no new platform port, no dependency bump.

## Official migration guide × SDK types (reconciliation)

Google's `generateContent`→Interactions migration guide was cross-checked against
the installed `@google/genai@2.9.0` `.d.ts`. Most of it matches; the mismatches
matter because **TeXRA's TypeScript sees the SDK types, not the guide's prose/REST
JSON** — trust the `.d.ts` where they differ.

**Confirmed by both:**

- **State on by default.** `store` defaults `true` (server-side history); set
  `store:false` for stateless behaviour. So TeXRA has two clean options:
  `store:false` for drop-in parity with today's stateless resend, or
  `store:true` + `previous_interaction_id` for the payload win. (Resolves the
  open question in risk #2 — both are first-class.)
- **Convenience accessors exist** on the returned interaction: `output_text`
  (`:7053`), `output_image?: ImageContent` (`:7057`), and
  `output_audio?: AudioContent` (`:7061`). `output_text` joins only the
  _trailing_ `TextContent` run, so anything interleaved with
  thoughts/tools/images still requires walking `steps` — which TeXRA does anyway
  (thinking is separated, tools are handled).
- **Function-result round-trip:** submit the result as a **new** `create` call
  with `previous_interaction_id` and `input` = a `function_result`
  `{ type:"function_result", call_id: <call.id>, name, result:[{type:"text",text}] }`.
  The pending interaction reports `status:"requires_action"` and the
  `function_call` step sits `status:"waiting"`. `InteractionStatus` (`:7620`) =
  `in_progress|requires_action|completed|failed|cancelled|incomplete|budget_exceeded`.
- **Structured output** is a top-level `response_format` array of
  `{ type:"text", mime_type:"application/json", schema }` (`response_mime_type` is
  deprecated). **Streaming** discriminates events on `event_type`
  (`interaction.created` / `interaction.completed` /
  `interaction.status_update` / `step.start` / `step.delta` / `step.stop` /
  `error`). Interaction states such as `in_progress` and `requires_action` live
  on `InteractionStatusUpdate.status`, not in `event_type`. `TextDelta` =
  `{ type:"text", text }` (`:11995`).
- **Stateless function-calling history:** the official guide requires the next
  `store:false` request to include the initial `user_input` step, all
  model-generated steps exactly as received (including `thought` and
  `function_call`), and the local `function_result` step. This matches v0's
  local-history plan and is the contract the tests should encode. In code shape,
  this means `input: [initialUserInputStep, ...turn1.steps, functionResultStep]`
  with no `previous_interaction_id`.
- **Explicit caching is not yet available in Interactions.** The SDK exposes
  `cached_content`, but the overview lists explicit caching under
  generateContent-only limitations and points Interactions users at implicit
  caching through `previous_interaction_id`.
- **Built-in tools are transparent:** `google_search_call` + `google_search_result`
  steps, with **inline** citations as an `annotations` array on the
  `model_output` text content (vs the old separate `groundingMetadata`).

**Discrepancies — follow the SDK, not the guide:**

- **Streamed tool args.** Guide prose: `delta.type === "arguments"` /
  `delta.partial_arguments`. SDK: `ArgumentsDelta` (`:527`) is
  `{ type:"arguments_delta", arguments?: string }`. The low line number is
  anomalous but real in the `@google/genai@2.9.0` tarball; use
  `"arguments_delta"` and the `arguments` field.
- **Usage field names.** Guide REST JSON shows `prompt_tokens` /
  `completion_tokens` / `total_tokens`; the SDK `Usage` type (`:13952`) has
  **none** of those — it exposes `total_input_tokens` / `total_output_tokens` /
  `total_cached_tokens` / `total_tool_use_tokens` / `total_thought_tokens`
  (+ `*_by_modality`). `googleUsage.ts` must map the SDK names.
- **REST path / API version** examples currently use `/v1beta/interactions` while
  the SDK README says default endpoints are beta unless `apiVersion` is set.
  This is informational for the design because TeXRA calls the SDK, but v0
  should add a real-key smoke test before hardcoding `apiVersion:'v1'` or reusing
  any relay endpoint assumptions.

## Mapping: `generateContent`/chat → Interactions

| TeXRA concern                     | Today (chat/`generateContent`)                               | Interactions (verified)                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send a turn                       | `chat.sendMessage(parts)`                                    | `interactions.create({ model, input })`                                                                                                                       |
| Streaming                         | `sendMessageStream()` → `chunk.candidates[0].content.parts`  | `Stream<InteractionSSEEvent>`; consume `event_type:"step.delta"` → `delta` (TextDelta etc.)                                                                   |
| Conversation state                | resend full `Content[]` each round                           | v0: pass prior `Step[]` in `input` with `store:false`; later: `previous_interaction_id` when using `store:true`                                               |
| System prompt                     | `systemInstruction` on chat params                           | `system_instruction` on create                                                                                                                                |
| Custom tools                      | `[{ functionDeclarations:[…] }]`                             | `tools:[{ type:"function", name, description, parameters }]`                                                                                                  |
| Built-in search                   | **disabled** (can't mix w/ functions)                        | same `tools` array type as custom functions; enable mixed requests after model-gated smoke tests                                                              |
| Tool call out                     | `functionCall` part                                          | `FunctionCallStep` `{ name, arguments, id }` (+ streamed `ArgumentsDelta`)                                                                                    |
| Tool result in                    | `functionResponse` part (user msg)                           | a `function_result` step/input `{ call_id, result }`; `result` may include images                                                                             |
| **Parallel tools + thought sigs** | batched into one model `Content`, signature on the call part | custom function steps have no signature fields in 2.9.0; preserve `ThoughtStep.signature`/`ThoughtSignatureDelta` and any signed built-in tool steps verbatim |
| Thinking                          | `thinkingConfig` + `thought` parts                           | `generation_config` thinking + `ThoughtStep`/`ThoughtSummaryDelta`                                                                                            |
| Multimodal in                     | inline base64 / File API `uri` parts                         | typed `Content` (`ImageContent`/`DocumentContent`/…) in `input`                                                                                               |
| Token counting                    | `client.models.countTokens()`                                | unchanged — still on `client.models`                                                                                                                          |
| Usage/pricing                     | `GenerateContentResponseUsageMetadata`                       | `Usage` (`total_*_tokens`) → remap `googleUsage.ts`                                                                                                           |
| Background                        | n/a today                                                    | `background:true` (+ `store`, `webhook_config`)                                                                                                               |
| Caching                           | explicit cache rebate via `cachedContentTokenCount`          | v0: no explicit cache parity; later `store:true` can use implicit caching via `previous_interaction_id`; explicit caching is documented as unavailable        |

For v0, `store:false` means the handler cannot rely on `previous_interaction_id`;
conversation state must come from local `Step[]` resending. Send request-level
fields (`system_instruction`, `tools`, `generation_config`, `response_format`)
on every `interactions.create` request rather than assuming they persist across
future `previous_interaction_id` continuations. This mirrors the OpenAI
Responses implementation, which re-sends instructions with each request; a later
`store:true` phase can loosen this only after a real-key fixture proves
continuation semantics.

## Design (additive, feature-flagged)

Mirror the OpenAI Responses precedent end to end.

### 1. New handler

`ModelHandlerGoogleInteractions` in
`src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts`, extending
`ModelHandler` like the existing Google handler.

- **Reuse:** `googleSdkError.ts` (same `GoogleApiError`); the JSON-Schema
  flattening/`$schema`-stripping in `toolConversion.ts` (wire-agnostic) — feed it
  into `FunctionT.parameters` instead of `functionDeclarations`; the media
  upload size/threshold logic; the credential/base URL/retry setup from
  `getClient`, with an explicit Interactions API-version smoke test before
  choosing an `apiVersion` override.
- **Rewrite:** input construction (typed `Content` + optional prior `Step[]` /
  `previous_interaction_id`), the streaming loop (SSE `event_type` events, route
  `TextDelta` → output, `ThoughtSummaryDelta`/`ThoughtSignatureDelta` → thinking,
  `ArgumentsDelta`/`FunctionCallStep` → tool calls), tool-result steps, and
  `googleUsage.ts` for the `Usage` shape.

### 2. Compatibility key

Add `'ModelHandlerGoogleInteractions'` to `ModelHandlerCompatibilityKey`
(`ModelFactory.ts:29`). Interactions persists state server-side and continues via
`previous_interaction_id`; its history shape differs from the chat handler's
`Content[]`, so a distinct key is mandatory for history restore/compaction.

### 3. Routing predicate + factory branch

Add `shouldUseGoogleInteractionsAPI(config, useOpenRouter)` next to
`shouldUseResponsesAPI`. Gate on a new setting plus per-model
`requiresInteractionsAPI` for model ids that cannot use `generateContent`.
Branch in `createModelHandler()` **before** the default Google route, and exclude
`useOpenRouter` (OpenRouter can't proxy Interactions). If an Interactions-only
model is selected while `useOpenRouter` is active, surface a clear availability
error instead of silently falling back to the chat handler.

### 4. Settings

Add `model.useGoogleInteractionsAPI` to `coreSettings.ts` (the three sites at
~81/325/564), mirroring `useOpenAIResponsesAPI`; reuse
`model.useBackgroundResponses` only for the later `store:true`/background phase
(v0 ignores it because v0 uses `store:false`). Surface in Settings → Models;
document in `docs/guide/configuration.md`.

### 5. Model registry

Register only model-mode Interactions-supported ids in v0 (`llm-zoo`
`MODEL_CONFIGS` + `src/model/` capability/pricing). The official overview
currently includes Gemini 3.1/3/2.5 model ids, Lyria preview model ids, and Deep
Research / Antigravity preview agent ids; keep agent-only ids documented but do
not expose them until an agent-mode branch exists. Confirm the exact model set
and pricing at impl time.

## Platform / VS Code separation

No new host coupling. The handler stays in the VS Code-free `modelHandlers/`
zone, reaching host services only through `platform()` (secrets for the API key
via the base `getApiKey()`, config, fs for media) — identical to the existing
Google handler. The settings toggle flows through the existing `coreSettings`
schema; no new ports.

## Risks & open questions

1. **Thought/signature model changed (re-scope, not eliminate).** In chat,
   Gemini 3 signatures ride on generated parts and TeXRA batches parallel
   results into one message. In Interactions, custom `FunctionCallStep` and
   `FunctionResultStep` have no `signature` field in `@google/genai@2.9.0`;
   thought signatures are `ThoughtStep.signature` (+ `ThoughtSignatureDelta`).
   Several built-in tool call/result step types also expose `signature`, so
   stateless mode must round-trip all prior `Step[]` entries verbatim rather
   than reconstructing only a thought/function subset. Needs a fixture test
   either way; this is still the place most likely to silently break parallel
   tool use.
2. **Server-side state vs history/compaction.** TeXRA's restore/compaction assume
   a resend-able local transcript. The guide confirms `store` makes both modes
   first-class: `store:false` = stateless drop-in parity (send local
   `user_input` steps plus returned model steps each round; simplest, keeps
   compaction working unchanged) vs `store:true` (default) with
   `previous_interaction_id` (payload win, but the server — not TeXRA — then owns
   compaction, and behaviour must be defined when the stored interaction has
   expired or a run is restored from old history). Official retention is
   currently 55 days on paid tier / 1 day on free tier (`⚠️` confirm at
   implementation time); note `store:false` is incompatible with
   `background=true` and with later `previous_interaction_id` use. **Recommend
   `store:false` for v0** to preserve the existing history/compaction contract,
   treating server-side continuation (+ background) as a later optimisation.
3. **GA service with active SDK churn.** The official overview marks the API GA,
   and the types ship in the pinned SDK version; `response_mime_type` is already
   deprecated in favour of `response_format`, signalling churn. Pin/snapshot the
   working version, verify key/model access in a real-key smoke test, and keep
   `generateContent` as fallback.
4. **Usage/pricing remap.** `Usage.total_*` field names → `googleUsage.ts`
   re-derivation; re-validate implicit-cache and reasoning-token accounting. Do
   not claim explicit `cached_content` parity until Google marks explicit caching
   available for Interactions despite the field existing in SDK types.
5. **API version and relay compatibility.** The existing Google handler does not
   set `apiVersion`; the SDK defaults to beta endpoints, and official REST
   examples currently use `/v1beta/interactions`. Before enabling included relay
   keys or hardcoding `apiVersion:'v1'`, smoke-test personal-key and relay-key
   calls for endpoint support, snake_case request fields, and error mapping.
6. **Managed agents are a different product.** `agent=` + `environment:'remote'`
   provisions a remote sandbox (browse/exec). **Out of scope for v0**
   (model-mode only); track separately.
7. **Service ids / pricing** (`⚠️ confirm`): supported model and agent ids are
   listed in the official overview, but TeXRA still needs an implementation-time
   decision about which ids to register plus current $/token pricing and
   `ServiceTier` Flex/Priority cost deltas.

## Scope

**In (v0):** `ModelHandlerGoogleInteractions` in **model mode** (text +
multimodal in, SSE streaming, custom function calling incl. parallel calls +
verbatim `Step[]` signature round-trip, thinking, token counting, `Usage`-based
pricing); compatibility key; routing predicate + factory branch;
`useGoogleInteractionsAPI` setting + Settings UI + docs; tests (streaming SSE,
parallel-tool/thought-signature, usage mapping, routing); keep `generateContent`
as default fallback.

**Out (v0):** managed agents (`agent=`, `environment:'remote'`); media generation
(`response_modalities`/image/audio out); explicit `cached_content` parity; Deep
Research agent; making Interactions the **default** for Gemini (ship behind the
flag, flip later); OpenRouter support.

## Milestones

1. ~~Verify the SDK schema~~ ✅ done (this proposal; `@google/genai@2.9.0`).
   Remaining: choose/register the supported model/agent ids and confirm pricing
   (`⚠️` items).
2. `ModelHandlerGoogleInteractions` (model mode): SSE streaming + custom tools;
   compatibility key; factory routing behind `useGoogleInteractionsAPI` (default
   **off**). Unit tests on input/tool/usage translation (mocked SDK), explicitly
   the parallel-tool/verbatim-steps signature round-trip.
3. Multimodal `Content` input, thinking, token counting, implicit-cache usage
   accounting; settings UI + `configuration.md`.
4. Mixed built-in `google_search` + functions after model-gated smoke tests
   confirm support for the selected model ids.
5. Real-key smoke test; CHANGELOG; decide per-model default flip; register GA ids.

## References

- SDK types (authoritative, verified): `@google/genai@2.9.0`
  `dist/genai.d.ts` — `GeminiNextGenInteractions` (`:4598`), `CreateModelInteraction`
  (`:2373`), `Interaction` (`:6943`), `Step` (`:11664`), `Usage` (`:13952`),
  `interactions` namespace (`:7367`).
- Interactions overview: https://ai.google.dev/gemini-api/docs/interactions/interactions-overview
- API reference: https://ai.google.dev/api/interactions-api
- Function calling: https://ai.google.dev/gemini-api/docs/interactions/function-calling
- Streaming: https://ai.google.dev/gemini-api/docs/interactions/streaming
- Announcement: https://blog.google/innovation-and-ai/technology/developers-tools/interactions-api/
- JS SDK: https://github.com/googleapis/js-genai
- TeXRA precedent: [`2025-06-04-openai-responses-api.md`](./2025-06-04-openai-responses-api.md);
  routing `src/agent/runtime/ModelFactory.ts:175`; settings `src/shared/schemas/coreSettings.ts`.

> _The SDK `.d.ts` (verified above) is the source of truth for request/response
> shapes. The official overview is the source for GA status, recommended use,
> supported ids, and retention; `⚠️` is reserved for implementation-time pricing
> and model-registration decisions._
