# Implementation Spec: `ModelHandlerGoogleInteractions`

> **Status:** Implemented (2026-07-04 status sweep). The additive Google
> Interactions handler now lives at
> `src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts`; this spec
> is retained as the implementation evidence trail.

Single source of truth for adding an additive, feature-flagged Google Gemini **Interactions API** handler beside the existing chat/`generateContent` handler. Mirrors the OpenAI-Responses precedent end to end. SDK shapes are verified against `@google/genai@2.9.0` `node_modules/@google/genai/dist/genai.d.ts`.

## 0. Corrections to the proposal's cited facts (verified against current code)

The proposal's line numbers were checked against the actual files. Corrections:

- **ModelFactory routing has FOUR edit sites, not three.** The proposal/reports name three (compat-key enum, `shouldUse…`, factory branch) but **miss `compatibilityKeyForConfig()` at `ModelFactory.ts:258-264`**, which independently re-derives the compatibility key for history restore and _also_ checks `shouldUseResponsesAPI` before the provider route. The Interactions branch must be added there too or restored runs mis-key. This is mandatory — see §1.
- **Correct ModelFactory anchors:** compat-key type `:29`; `requiresOpenAIResponsesAPI` `:152`; `shouldUseResponsesAPI` `:175`; `compatibilityKeyForConfig` predicate block `:258`; `createModelHandler` `:313`; OpenAI-Responses branch `:361-369`; OpenRouter branch `:371`; direct-provider route `:385`. Insert the Interactions factory branch **after `:369` (after the Responses branch) and before `:371` (the OpenRouter branch)**.
- **Correct coreSettings anchors:** default literal `:81` (`useOpenAIResponsesAPI: true`); Zod field `:325-327`; `CORE_SETTING_PATHS` entry `:564`. All three reports' anchors are correct.
- **The `requiresBatchedParallelToolResults` getter is at `:346`** (not a generic claim) and returns `true` — but see §6: in Interactions 2.9.0 custom `FunctionCallStep`/`FunctionResultStep` carry **no signature field**; the round-trip is whole-`Step[]`-verbatim, not signature-on-first-call batching. The batched override (`createBatchedToolUseFollowUpMessages`) does NOT carry over its Gemini-3-chat semantics.
- **`createResponseImpl` exact signature (chat handler `:405`)** — the new handler overrides the same signature:
  ```ts
  protected override async createResponseImpl(
    options: CreateResponseOptions<Content, GoogleGenAI>,
  ): Promise<CreateResponseResult<GenerateContentResponse, Content>>
  ```
  The Interactions handler's generics differ (see §3) so its `Resp` is `GoogleGenAIInteraction`, not `GenerateContentResponse`.
- **SDK Usage field names are snake_case and DO NOT include the guide's `prompt_tokens`/`completion_tokens`.** Verified: `total_input_tokens`, `total_output_tokens`, `total_cached_tokens`, `total_tool_use_tokens`, `total_thought_tokens` (`genai.d.ts:13952`). The existing `googleUsage.ts` reads **camelCase** `promptTokenCount`/`candidatesTokenCount`/`thoughtsTokenCount`/`totalTokenCount`/`cachedContentTokenCount` — a real mismatch requiring an adapter (§4).
- **`ArgumentsDelta` discriminator is `"arguments_delta"`** with field `arguments?: string` (`genai.d.ts:527`) — NOT the migration guide's `"arguments"`/`partial_arguments`. The low line number is anomalous but real; follow the `.d.ts`.
- **Interaction lifecycle states (`in_progress`, `requires_action`) are `status` field values, not `event_type` values.** The `event_type` literals are exactly: `"interaction.created"`, `"interaction.completed"`, `"interaction.status_update"`, `"error"`, `"step.start"`, `"step.delta"`, `"step.stop"`.
- **Existing Google test directory is `src/test-kernel/agent/modelHandlers/`** (not `src/test-kernel/model/`). `ModelHandlerGoogle.vitest.ts` lives one level up at `src/test-kernel/modelHandlers/`.

---

## Section 1 — File-by-file edit list

### 1.1 NEW handler file

**`src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts`** (new, ~800-1000 lines). Class `ModelHandlerGoogleInteractions` extending `ModelHandler` with Interactions generics (§3). Implements all 19 abstract methods + the Google override hooks per the method plan in §2.

### 1.2 `src/agent/runtime/ModelFactory.ts` — FOUR edits

1. **`:29` compat-key type** — add `| 'ModelHandlerGoogleInteractions'` to `ModelHandlerCompatibilityKey` (place after `'ModelHandlerGoogleGenAI'`).
2. **New predicate** `shouldUseGoogleInteractionsAPI(config, useOpenRouter)` next to `shouldUseResponsesAPI` (~`:175`):
   ```ts
   export function shouldUseGoogleInteractionsAPI(
     config: ModelConfig,
     useOpenRouter: boolean,
   ): boolean {
     if (config.provider !== ModelProvider.GOOGLE || config.openRouterOnly) {
       return false;
     }
     if (useOpenRouter) return false; // OpenRouter cannot proxy Interactions
     if (config.requiresInteractionsAPI) return true;
     return getConfig<boolean>('texra.model.useGoogleInteractionsAPI', false);
   }
   ```
   (Default `false` for v0 — see §6 OpenRouter exclusion and the "ship behind flag" scope.)
3. **`compatibilityKeyForConfig` `:258`** — add **before** the existing `shouldUseResponsesAPI` check (or symmetrically right after it; order doesn't matter since providers are disjoint):
   ```ts
   if (shouldUseGoogleInteractionsAPI(config, useOpenRouter)) {
     return 'ModelHandlerGoogleInteractions';
   }
   ```
4. **`createModelHandler` factory branch** — insert after the Responses branch (`:369`), before OpenRouter (`:371`):
   ```ts
   if (shouldUseGoogleInteractionsAPI(config, useOpenRouter)) {
     logger.debug(CHANNEL, 'Using Google Interactions API Handler');
     const { ModelHandlerGoogleInteractions } =
       await import('@agent/modelHandlers/google/modelHandlerGoogleInteractions');
     return withModelHandlerCompatibilityKey(
       withReasoningOverride(new ModelHandlerGoogleInteractions(config)),
       'ModelHandlerGoogleInteractions',
     );
   }
   ```
   Do **not** touch `PROVIDER_HANDLER_ROUTES[GOOGLE]` (`:73`) — it remains the `generateContent` fallback.

### 1.3 `src/shared/schemas/coreSettings.ts` — THREE edits

1. **`:81`** in `DEFAULT_CORE_SETTINGS.model`, after `useOpenAIResponsesAPI: true,`:
   ```ts
   useGoogleInteractionsAPI: false,
   ```
   (Default `false` — v0 ships off; OpenAI's is `true` but Interactions is new/unproven per scope.)
2. **`:325-327`** in `CoreSettingsShape.model` strictObject, after the `useOpenAIResponsesAPI` field:
   ```ts
   useGoogleInteractionsAPI: z
     .boolean()
     .prefault(DEFAULT_CORE_SETTINGS.model.useGoogleInteractionsAPI),
   ```
3. **`:564`** in `CORE_SETTING_PATHS`, after `'model.useOpenAIResponsesAPI',`:
   ```ts
   'model.useGoogleInteractionsAPI',
   ```

### 1.4 `src/shared/constants/providers.ts` — settings UI

Expand the currently-empty `google: []` block in `PROVIDER_VSCODE_SETTINGS`:

```ts
google: [
  {
    key: 'texra.model.useGoogleInteractionsAPI',
    label: 'Use Interactions API',
    description:
      'Use the Google Interactions API instead of Generate Content when available.',
  },
],
```

No edits needed in `SettingsViewProvider.ts` / `SettingsViewMessageHandler.ts` — they generically iterate `PROVIDER_VSCODE_SETTINGS`.

### 1.5 Model registry (`llm-zoo` + `src/model/`)

- Add optional `requiresInteractionsAPI?: boolean` to the `ModelConfig` shape (parallel to `requiresResponsesAPI`; same place it is typed in `ProxyConfigResolver.ts:56-66` and read in `ModelFactory.ts`). If `llm-zoo` is external, the field must be added there; otherwise leave the predicate keying only off the setting and document the field as future.
- v0 registers **no** model with `requiresInteractionsAPI: true` (ship behind the flag). Pricing/capability entries in `src/model/computeModelOptions.ts` for any Interactions-targeted Gemini id are reused from the existing Gemini entries — same `inputPrice`/`outputPrice`/`cacheDiscountFactor` (the `pricingConfig()` hook is REUSE).

### 1.6 New `src/agent/modelHandlers/google/googleInteractionsUsage.ts`

Adapter mapping the snake_case Interactions `Usage` to the existing token-count/price/normalize pipeline (§4).

### 1.7 Docs

**`docs/guide/configuration.md`** (API Provider Settings, ~`:72-84`): add to JSON example `"texra.model.useGoogleInteractionsAPI": false,` and a bullet:

> - `useGoogleInteractionsAPI`: Use Google's Interactions API instead of Generate Content when available.

**`src/agent/modelHandlers/README.md`**: add a row for `ModelHandlerGoogleInteractions` mirroring the `ModelHandlerOpenAIResponse` row.

### 1.8 Tests — see §5 for assertions

- `src/test-kernel/agent/modelHandlers/ModelFactoryRouting.vitest.ts` (extend)
- `src/test-kernel/agent/modelHandlers/GoogleInteractionsStreaming.vitest.ts` (new)
- `src/test-kernel/agent/modelHandlers/GoogleInteractionsToolUse.vitest.ts` (new)
- `src/test-kernel/agent/modelHandlers/GoogleInteractionsUsage.vitest.ts` (new)
- `src/test-kernel/agent/modelHandlers/GoogleInteractionsMessages.vitest.ts` (new)
- `src/test-kernel/agent/modelHandlers/ModelFactoryRouting.vitest.ts` — restore/compat-key path (extend, see §5)

---

## Section 2 — Method-by-method plan

Classification: **REUSE** = copy verbatim from `modelHandlerGoogleGenAI.ts`; **PORT** = small change; **REWRITE** = new Interactions-SSE implementation.

### Capability getters / auth

- `getClient()` (`:294`) — **REUSE**. Same `GoogleGenAI` client + `getApiKey()` + server-relay routing. Optionally set `apiVersion` at construction (see §6); for v0 leave unset unless the smoke test requires it.
- `supportsTokenCounting` (`:338`) — **REUSE**.
- `requiresBatchedParallelToolResults` (`:346`) — **PORT**: return `false` for Interactions v0. Rationale: §6 — there's no signature-on-first-call batching; results are submitted as discrete `function_result` steps within one `input` array, and the whole `Step[]` is round-tripped verbatim. (If the runtime requires batched delivery semantics, keep `true` and implement `createBatchedToolUseFollowUpMessages` as "append all `function_result` steps to one `input`" — but the simpler model is `false` + verbatim resend.)
- `sdkErrorTagger` (`:400`) — **REUSE**. Same `tagGoogleSdkError` (`GoogleApiError` instances are identical across surfaces).
- `supportsFileUploads()` (`:113`), `getInlineUploadLimitBytes()` (`:187`), `resolveUploadMimeType()` (`:288`), `pricingConfig()` (`:838`), `createMediaContent()` (`:760`, returns input unchanged) — **REUSE**.
- `isGemini3Model()` (`:119`), `getMediaResolution()` (`:130`), `getThinkingLevel()` (`:147`) — **PORT**: same logic; `getThinkingLevel`/`getMediaResolution` feed `generation_config` instead of `thinkingConfig`/`GenerateContentConfig`. Map `ReasoningEffort` → thinking config on the Interactions `GenerationConfig_2`.

### Token counting

- `estimateTokenCount()` (`:357`) — **REUSE**. Token counting stays on `client.models.countTokens()` (proposal §"Token counting" confirms it is unchanged in Interactions). Build the same `Content[]` for counting; this is independent of the Interactions wire format.

### Usage / price

- `computePrice()` (`:831`) — **PORT**: delegate to a new `computeGoogleInteractionsPrice(rawUsage, pricingConfig())` from `googleInteractionsUsage.ts` (§4).
- `normalizeUsage()` (`:847`) — **PORT**: delegate to `normalizeGoogleInteractionsUsage(...)` (§4).

### Message construction (typed `Content` + `Step[]`, not chat parts)

The handler's `M` type is **`Step`** (history is `Step[]`); see §3/§6.

- `initializeMessages(userPrefix, userRequest, mediaFiles?, systemPrompt?)` (`:655`) — **REWRITE**: build a single `UserInputStep` `{ type:"user_input", content:[TextContent, …media Content] }`. Text → `{ type:"text", text }`. Media → `ImageContent`/`DocumentContent`/`AudioContent`/`VideoContent` (typed objects, not `Part`). System prompt is NOT a step — it's request-level `system_instruction` (carry it on the handler/options, sent on every `create`, §6). Reuse the media-label logic (`:666-673`) verbatim, redirecting output into typed `Content`.
- `createRoundMessages(messages, userMessage, mediaFiles?)` (`:684`) — **REWRITE**: append a new `UserInputStep` to the `Step[]`.
- `createUserFollowUpMessages(messages, userMessage)` (`:712`) — **REWRITE**: append/merge text into the trailing `user_input` step (or new step). No strict user/model alternation requirement in step form, but keep one `user_input` step per user turn for clarity.
- `createAssistantMessage(text)` (`:731`) — **REWRITE**: return `{ type:"model_output", content:[{ type:"text", text }] } satisfies ModelOutputStep`.
- `prependTextToUserMessage(messages, text)` (`:1332`) — **PORT**: find last `user_input` step, `unshift` a `TextContent` into its `content`.
- `addMediaToUserMessage(messages, mediaFiles)` (`:1344`) — **PORT**: find last `user_input` step, `unshift` typed media `Content` (via the rewritten `createMediaMessage`).
- `createMediaContent()` (`:760`) — **REUSE** (identity).
- `createMediaMessage()` (`:742`) / `uploadMediaEntries()` (`:191`) — **REWRITE**: inline ≤20 MB → `ImageContent`/`DocumentContent` with `data` (base64) + `mime_type`. >20 MB → `client.files.upload()` (still on `client.files`, unchanged) then reference via the `uri` field of the typed `Content` (`ImageContent.uri`/`DocumentContent.uri`). Reuse the size-threshold + mime resolution; rewrite only the output wrapping from `Part` to typed `Content`.

### Response extraction (walk `steps`, not candidate parts)

- `extractResponse(responseObject, endTag)` (`:765`) — **REWRITE**: walk `responseObject.steps`; concatenate `TextContent.text` from `ModelOutputStep.content` entries (skip `ThoughtStep`/tool steps); apply replacements; map status → stop reason (§ stop reason below); append `endTag` if status is terminal/`completed` and tag missing. Convenience: `responseObject.output_text` (SDK-added) joins only the trailing text run — prefer explicit step walk since thoughts/tools interleave.
- `extractAssistantText(message)` (`:736`) — **PORT**: for a `ModelOutputStep`, join its `content` `TextContent.text`. Check `message.type === 'model_output'` (not `role === 'model'`).
- `extractToolUse(responseObject)` (`:1069`) — **REWRITE**: iterate `steps` for `type === "function_call"` (`FunctionCallStep`); build `GoogleToolCall[]` from `{ name, arguments, id }` → `{ callId: step.id, name: step.name, input: step.arguments }`. There is **no** `thoughtSignature` on the function-call step (2.9.0) — signatures live on adjacent `ThoughtStep.signature`; capture and store those separately for verbatim round-trip (§6).
- `processThinkingBlock(responseObject, workspaceState?)` (`:1033`) — **REWRITE**: iterate `steps` for `type === "thought"` (`ThoughtStep`); extract `summary` (`ThoughtSummaryContent[]`) text and `signature`; write thinking text + persist `signature` into workspace reasoning state. (In streaming this is fed by `ThoughtSummaryDelta`/`ThoughtSignatureDelta`, § stream loop.)

### Stop / continue

- `shouldContinue(stopReason, newResponse, agentSetting)` (`:1012`) — **PORT**: replace `FinishReason.MAX_TOKENS` with the Interactions terminal-status mapping. Continue when status is `"incomplete"` (truncated) and `!hasEndTag(newResponse)`. `InteractionStatus` = `"in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "incomplete" | "budget_exceeded"` (`genai.d.ts:7620`).
- `addContinueMessageWithPrefill` (`:854`) / `addContinueMessageWithoutPrefill` (`:864`) — **PORT**: append a `UserInputStep` with the continuation prompt (`createContinuationPrompt()` inherited). Prefill not supported (same as chat) — with-prefill delegates to without.
- `updateMessageContentWithPrefill` (`:879`) / `updateMessageContentWithoutPrefill` (`:890`) — **PORT**: same removal-of-continuation-prompt + update-trailing-`model_output`-text logic, re-expressed against `ModelOutputStep.content` text entries.
- `initializeOutputAndPrefill(...)` (`:936`) — **PORT**: reuse `prepareExistingOutputContent()` + `hasEndTag()`; pseudo-prefill expressed as a `UserInputStep` carrying the existing file content. Media via the rewritten `createMediaMessage`.

### Tool round-trip

- `createToolUseFollowUpMessages(client, call, result, attachments, workspaceState?, text?)` (`:1211`) — **REWRITE**: emit the assistant turn as the model-generated `Step[]` already in history (the `function_call` + any `thought` steps round-tripped verbatim) plus a new `function_result` step:
  ```ts
  {
    type: "function_result",
    call_id: call.callId,
    name: call.name,
    is_error: result.isError ?? undefined,
    result: [{ type: "text", text: <result text> }, ...imageSubcontent],
  } satisfies FunctionResultStep
  ```
  `result` may be `string | FunctionResultStepResult | Array<FunctionResultSubcontent>` where `FunctionResultSubcontent = TextContent | ImageContent` (`:4553`) — tool-result images go here as `ImageContent`. Attachments → base64 `ImageContent` entries (port `buildFunctionResponseAttachment` `:1097` encoding, rewrap as `ImageContent`).
- `createBatchedToolUseFollowUpMessages()` (`:1267`) — **REWRITE or DROP**: if `requiresBatchedParallelToolResults` returns `false`, this is unused. If kept `true`, implement as: append all parallel `function_result` steps (one per `call_id`) into a single submission `input` array, preserving the original `function_call`/`thought` steps verbatim ahead of them.

### The streaming loop — `createResponseImpl()` (REWRITE, the core)

Build params and call:

```ts
const input: InteractionsInput = [...history /* Step[] */, lastUserInputStep];
const params: CreateModelInteractionParamsStreaming = {
  model: this.config.fullName,
  input,
  stream: true,
  store: false,                       // v0: stateless (§6)
  system_instruction: systemPrompt,   // resent every request (§6)
  tools: toInteractionsTools(toolDefs), // FunctionT[] (§4)
  generation_config: this.buildGenerationConfig(temperature, ...),
};
const stream = await client.interactions.create(params, { abortSignal: signal });
```

Consume the `Stream<GoogleGenAIInteractionSSEEvent>` via `for await (const event of stream)`. **Switch on `event.event_type`:**

- `"interaction.created"` → record interaction `id` (needed for `previous_interaction_id` in later phases; ignore for v0 stateless beyond logging).
- `"step.start"` → `event.step.type` tells what's beginning. For `"function_call"` start, seed a pending tool-call buffer keyed by `event.index` with `{ id, name, arguments: "" }`. For `"thought"`/`"model_output"` start, open the corresponding accumulator.
- `"step.delta"` → switch on `event.delta.type` (`StepDeltaData` union, `:11685`):
  - `"text"` (`TextDelta`, `:11995`) → **route to OUTPUT**: emit `event.delta.text` to the output stream/scratchpad.
  - `"thought_summary"` (`ThoughtSummaryDelta`, `:12128`) → **route to THINKING**: append `event.delta.content` text to reasoning.
  - `"thought_signature"` (`ThoughtSignatureDelta`, `:12099`) → **store signature** on the current thought step for verbatim round-trip (§6).
  - `"arguments_delta"` (`ArgumentsDelta`, `:527`) → **route to TOOL-ARGS**: append `event.delta.arguments` (string) to the pending tool-call buffer at `event.index`.
  - image/audio/doc/video deltas → ignore in v0 (no media-out).
  - built-in tool call/result deltas (`GoogleSearchCallDelta`, etc.) → ignore in v0 (no built-ins).
  - `event.metadata?.total_usage` (`StepDeltaMetadata.total_usage: Usage`, `:11690`) → capture running usage.
- `"step.stop"` → finalize the step at `event.index`: parse the accumulated `arguments` string to JSON for completed `function_call` buffers; close text/thought accumulators.
- `"interaction.status_update"` → read `.status`; on `"requires_action"` mark that tool calls are pending (the run loop will submit `function_result` steps next round).
- `"interaction.completed"` → capture the final `Interaction` (carries `usage: Usage`, full `steps: Step[]`, `status`); build the `CreateResponseResult`.
- `"error"` (`ErrorEvent_2`) → throw a tagged SDK error (via `sdkErrorTagger`).

After the loop, assemble `CreateResponseResult<GoogleGenAIInteraction, Step>`:

- aggregated output text, the finalized `Step[]` (push the model-generated steps onto history for verbatim round-trip), the `Usage` (prefer the completed interaction's `usage`, fall back to last `total_usage` from deltas), the mapped stop/status, and extracted `GoogleToolCall[]` from `function_call` steps.

Non-streaming path (`stream: false`) returns `Promise<GoogleGenAIInteraction>` directly — read `.steps` and `.usage` from the resolved interaction; same extraction as the completed-event branch.

---

## Section 3 — Exact SDK type names + import paths + discriminators

All from `@google/genai` (the package re-exports the `interactions` namespace types). Import:

```ts
import {
  GoogleGenAI,
  type CreateModelInteractionParamsStreaming,
  type CreateModelInteractionParamsNonStreaming,
  type GoogleGenAIInteraction,
  type GoogleGenAIInteractionSSEEvent, // alias for the SSE event union
} from '@google/genai';
```

> Note: several Interactions types are namespaced/aliased internally (`Content_2`, `Tool_2`, `GoogleSearch_2`, `ErrorEvent_2`, `MediaResolution_2`, `ServiceTier_2`, `WebhookConfig_2`, `Environment_2`, `GenerationConfig_2`, `Model_2`) in `genai.d.ts`. Reference them via the package's public export surface (the `interactions.*` namespace) rather than the `_2` internal aliases. Confirm the exact public export names at impl time with a one-line `import` typecheck; the proposal calls these `Content`, `Tool`, `GoogleSearch`, etc. (unsuffixed) on the public surface.

**Core types (line refs in `genai.d.ts`):**

| Purpose                    | Type                                                                                                                                                          | line        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Client getter              | `client.interactions: GeminiNextGenInteractions`                                                                                                              | 5677 / 4598 |
| Request (model, streaming) | `CreateModelInteractionParamsStreaming` (= `Omit<CreateInteractionRequest,"body"> & CreateModelInteraction` + `stream:true`)                                  | 2450 / 2373 |
| Request body               | `CreateModelInteraction`                                                                                                                                      | 2373        |
| Input union                | `InteractionsInput = string \| Array<Step> \| Array<Content> \| Array<Turn> \| Content`                                                                       | 7555        |
| Content union              | `Content = TextContent \| ImageContent \| AudioContent \| DocumentContent \| VideoContent`                                                                    | 1841        |
| Text content               | `TextContent = { type:"text", text:string, annotations? }`                                                                                                    | 11976       |
| Image content              | `ImageContent = { type:"image", data?, uri?, mime_type?, resolution? }`                                                                                       | 6704        |
| Document content           | `DocumentContent = { type:"document", data?, uri?, mime_type? }`                                                                                              | 3036        |
| Audio content              | `AudioContent = { type:"audio", data?, uri?, mime_type?, channels?, sample_rate? }`                                                                           | 550         |
| Video content              | `VideoContent = { type:"video", data?, uri?, mime_type?, resolution? }`                                                                                       | 14252       |
| Tool union                 | `Tool = FunctionT \| CodeExecution \| URLContext \| ComputerUse \| MCPServer \| GoogleSearch \| FileSearch \| GoogleMaps \| Retrieval`                        | 12272       |
| Custom function tool       | `FunctionT = { type:"function", name?, description?, parameters?:any }`                                                                                       | 4565        |
| Built-in search            | `GoogleSearch = { type:"google_search", search_types? }`                                                                                                      | 5965        |
| Step union                 | `Step` (17 variants)                                                                                                                                          | 11664       |
| User input step            | `UserInputStep = { type:"user_input", content?: Content[] }`                                                                                                  | 14035       |
| Model output step          | `ModelOutputStep = { type:"model_output", content?: Content[] }`                                                                                              | 9235        |
| Thought step               | `ThoughtStep = { type:"thought", signature?:string, summary?: ThoughtSummaryContent[] }`                                                                      | 12112       |
| Function call step         | `FunctionCallStep = { type:"function_call", name:string, arguments:{[k:string]:any}, id:string }`                                                             | 4403        |
| Function result step       | `FunctionResultStep = { type:"function_result", name?, is_error?, call_id:string, result: FunctionResultStepResult \| FunctionResultSubcontent[] \| string }` | 4526        |
| Result subcontent          | `FunctionResultSubcontent = TextContent \| ImageContent`                                                                                                      | 4553        |
| Response (SDK-wrapped)     | `GoogleGenAIInteraction` (= `Interaction` with `steps: Step[]` + http response)                                                                               | 5683        |
| Response body              | `Interaction` (`id`, `status`, `usage?`, `steps?`, `output_text?`, …)                                                                                         | 6943        |
| Status enum                | `InteractionStatus`                                                                                                                                           | 7620        |
| SSE event union            | `InteractionSSEEvent = InteractionCreatedEvent \| InteractionCompletedEvent \| InteractionStatusUpdate \| ErrorEvent \| StepStart \| StepDelta \| StepStop`   | 7559        |
| Step start event           | `StepStart = { event_type:"step.start", index, step: Step, event_id?, metadata? }`                                                                            | 11699       |
| Step delta event           | `StepDelta = { event_type:"step.delta", index, delta: StepDeltaData, event_id?, metadata? }`                                                                  | 11668       |
| Step stop event            | `StepStop = { event_type:"step.stop", index, event_id?, metadata? }`                                                                                          | 11718       |
| Delta data union           | `StepDeltaData` (22 variants)                                                                                                                                 | 11685       |
| Text delta                 | `TextDelta = { type:"text", text:string }`                                                                                                                    | 11995       |
| Args delta                 | `ArgumentsDelta = { type:"arguments_delta", arguments?:string }`                                                                                              | 527         |
| Thought summary delta      | `ThoughtSummaryDelta = { type:"thought_summary", content?: Content }`                                                                                         | 12128       |
| Thought sig delta          | `ThoughtSignatureDelta = { type:"thought_signature", signature?:string }`                                                                                     | 12099       |
| Function result delta      | `FunctionResultDelta = { type:"function_result", name?, is_error?, call_id, result }`                                                                         | 4506        |
| Delta metadata             | `StepDeltaMetadata = { total_usage?: Usage }`                                                                                                                 | 11690       |
| Usage                      | `Usage` (snake_case totals)                                                                                                                                   | 13952       |

**Discriminator string literals the handler switches on:**

- `event.event_type`: `"interaction.created"`, `"interaction.completed"`, `"interaction.status_update"`, `"error"`, `"step.start"`, `"step.delta"`, `"step.stop"`.
- `step.type`: `"user_input"`, `"model_output"`, `"thought"`, `"function_call"`, `"function_result"` (+ built-in `*_call`/`*_result` ignored in v0).
- `delta.type`: `"text"`, `"thought_summary"`, `"thought_signature"`, `"arguments_delta"`, `"function_result"` (+ media/built-in ignored in v0).
- `content.type`: `"text"`, `"image"`, `"audio"`, `"document"`, `"video"`.
- `tool.type`: `"function"`, `"google_search"` (+ others ignored in v0).
- `interaction.status`: `"in_progress"`, `"requires_action"`, `"completed"`, `"failed"`, `"cancelled"`, `"incomplete"`, `"budget_exceeded"`.

---

## Section 4 — Helper remapping

### 4.1 Usage adapter (the snake_case ↔ camelCase mismatch — the critical one)

The existing `googleUsage.ts` reads **camelCase** `GenerateContentResponseUsageMetadata` fields. The Interactions `Usage` (`:13952`) is **snake_case** with different names. Create **`src/agent/modelHandlers/google/googleInteractionsUsage.ts`** that maps SDK `Usage` → the same internal `GoogleTokenCounts` shape, then reuses the standard price/normalize machinery (do NOT duplicate `computeStandardPrice`/`normalizeUsage`):

| Internal field | camelCase (`GenerateContentResponseUsageMetadata`) | snake_case (Interactions `Usage`)                                                             |
| -------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| input          | `promptTokenCount` (+ `toolUsePromptTokenCount`)   | `total_input_tokens` (tool-use is `total_tool_use_tokens`, separate)                          |
| output         | `candidatesTokenCount` + `thoughtsTokenCount`      | `total_output_tokens` (already includes thoughts? verify; if not, add `total_thought_tokens`) |
| reasoning      | `thoughtsTokenCount`                               | `total_thought_tokens`                                                                        |
| cached         | `cachedContentTokenCount`                          | `total_cached_tokens`                                                                         |
| tool-use       | `toolUsePromptTokenCount`                          | `total_tool_use_tokens`                                                                       |
| total          | `totalTokenCount`                                  | (grand-total field; derive if absent)                                                         |

Implementation: copy `computeGoogleTokenCounts` logic from `googleUsage.ts:39-66` into a `computeInteractionsTokenCounts(usage: Usage)` that reads the snake_case fields; export `computeGoogleInteractionsPrice` and `normalizeGoogleInteractionsUsage` mirroring `computeGooglePrice` (`:69`) / `normalizeGoogleUsage` (`:90`), passing `provider:'google'` to the shared `normalizeUsage` and reusing `computeStandardPrice` + `GooglePricingConfig`/`StandardPricingConfig` unchanged. **Verify at impl time** whether `total_output_tokens` already includes thought tokens (the chat formula does `candidates + thoughts`); if Interactions' `total_output_tokens` already includes thoughts, do NOT add them again.

### 4.2 Tools adapter

Add `toInteractionsTools(defs: ToolDefinition[]): FunctionT[]` (small wrapper) reusing the **wire-agnostic** `convertToolSchema(def)` from `toolConversion.ts` (the JSON-Schema flattening + `$schema` stripping) — feed its output into `FunctionT.parameters` instead of `functionDeclarations`. `toGoogleTools()` itself is NOT reused (it wraps into `[{ functionDeclarations }]`); only the inner `convertToolSchema`/`flattenTopLevelUnion`/`stripDollarSchema` are reused as-is.

### 4.3 Reused as-is (no remap)

- `googleSdkError.ts` `tagGoogleSdkError` — REUSE (`GoogleApiError` is shared).
- `fileContentUtils.ts` `prepareExistingOutputContent` / `PreparedFileContent` — REUSE.
- `googleMessageHelpers.ts` `isTextPart` — N/A for steps (Interactions uses typed `Content`, not `Part`); write a tiny `isTextContent(c): c is TextContent` instead. `extractNonThinkingText` is Part-based — NOT reused; the step-walk in `extractResponse` replaces it. `validateGoogleMessageHistory` is role-alternation-based — NOT reused; steps don't have the same alternation invariant.

---

## Section 5 — Test plan

All under `src/test-kernel/agent/modelHandlers/`. Mock the SDK by stubbing `client.interactions.create` to return either a resolved `GoogleGenAIInteraction` or an async-iterable of `InteractionSSEEvent`.

### 5.1 `ModelFactoryRouting.vitest.ts` (extend)

- Asserts `createModelHandler(googleConfig)` returns `ModelHandlerGoogleInteractions` when `texra.model.useGoogleInteractionsAPI=true`, else `ModelHandlerGoogleGenAI`.
- Asserts `requiresInteractionsAPI:true` forces the Interactions handler even with the setting off.
- Asserts `useOpenRouter=true` **never** routes to Interactions (returns OpenRouter handler or surfaces availability error for Interactions-only models) — see §6.
- Asserts `compatibilityKeyForConfig(googleConfig, …)` returns `'ModelHandlerGoogleInteractions'` under the same conditions (history-restore parity).

### 5.2 `GoogleInteractionsStreaming.vitest.ts` (new)

Mock SSE sequence:

```
{ event_type:"interaction.created", interaction:{ id:"int_1" } }
{ event_type:"step.start", index:0, step:{ type:"thought" } }
{ event_type:"step.delta", index:0, delta:{ type:"thought_summary", content:{ type:"text", text:"plan" } } }
{ event_type:"step.delta", index:0, delta:{ type:"thought_signature", signature:"sig_abc" } }
{ event_type:"step.stop", index:0 }
{ event_type:"step.start", index:1, step:{ type:"model_output" } }
{ event_type:"step.delta", index:1, delta:{ type:"text", text:"Hello " }, metadata:{ total_usage:{ total_input_tokens:10, total_output_tokens:2 } } }
{ event_type:"step.delta", index:1, delta:{ type:"text", text:"world" } }
{ event_type:"step.stop", index:1 }
{ event_type:"interaction.completed", interaction:{ id:"int_1", status:"completed", steps:[…], usage:{ total_input_tokens:10, total_output_tokens:3, total_thought_tokens:1 } } }
```

Asserts: output text = `"Hello world"`; thinking text = `"plan"`; thought signature `"sig_abc"` captured into workspace reasoning state and onto the round-trip `ThoughtStep`; final usage from the completed interaction; stop status `"completed"`.

### 5.3 `GoogleInteractionsToolUse.vitest.ts` (new)

Mock SSE with a parallel-tool turn:

```
step.start index:0 step:{ type:"function_call", id:"call_1", name:"search" }
step.delta index:0 delta:{ type:"arguments_delta", arguments:"{\"q\":" }
step.delta index:0 delta:{ type:"arguments_delta", arguments:"\"x\"}" }
step.stop index:0
step.start index:1 step:{ type:"function_call", id:"call_2", name:"fetch" }
step.delta index:1 delta:{ type:"arguments_delta", arguments:"{\"u\":\"y\"}" }
step.stop index:1
interaction.status_update status:"requires_action"
interaction.completed status:"requires_action" steps:[…]
```

Asserts: `extractToolUse` yields two `GoogleToolCall`s `{callId:"call_1",name:"search",input:{q:"x"}}` and `{callId:"call_2",name:"fetch",input:{u:"y"}}`; streamed `arguments_delta` chunks concatenate then JSON-parse correctly. Then `createToolUseFollowUpMessages` with a result containing an image produces a `function_result` step `{ type:"function_result", call_id:"call_1", result:[{type:"text",…},{type:"image",…}] }`, and the next-round `input` array is `[initialUserInputStep, ...modelGeneratedSteps (incl. function_call + thought verbatim), functionResultStep]` with **no** `previous_interaction_id` (stateless verbatim round-trip — §6).

### 5.4 `GoogleInteractionsUsage.vitest.ts` (new)

Given a snake_case `Usage` `{ total_input_tokens, total_output_tokens, total_cached_tokens, total_tool_use_tokens, total_thought_tokens }`, asserts `computeGoogleInteractionsPrice` and `normalizeGoogleInteractionsUsage` produce the same `NormalizedUsage`/price as the camelCase chat equivalent for matching token counts (cross-check against `GoogleCachePricing.vitest.ts` numbers). Includes a case verifying thoughts are not double-counted.

### 5.5 `GoogleInteractionsMessages.vitest.ts` (new)

Asserts `initializeMessages` builds a `UserInputStep` with typed `TextContent` + media `Content` (inline base64 ImageContent for ≤20 MB; `uri` ImageContent for >20 MB upload path); `createAssistantMessage` builds a `ModelOutputStep`; `prependTextToUserMessage`/`addMediaToUserMessage` mutate the trailing `user_input` step; `extractResponse` walks `steps` and appends `endTag` on terminal status.

---

## Section 6 — Risks & gotchas

1. **Thought-signature round-trip (most likely silent breakage).** In Interactions 2.9.0, custom `FunctionCallStep`/`FunctionResultStep` have **no `signature` field**; signatures live on `ThoughtStep.signature` (+ streamed `ThoughtSignatureDelta`) and on several built-in tool step types. Therefore: with `store:false`, the next request's `input` MUST include **all** model-generated `Step[]` from the prior turn **verbatim** (thought steps with their signatures, function-call steps, in original order) followed by the local `function_result` step(s). Do NOT reconstruct only a thought/function subset. This is why `requiresBatchedParallelToolResults` reduces to "resend the whole `Step[]`" rather than signature-on-first-call batching. Capture `ThoughtSignatureDelta.signature` during streaming and attach to the corresponding `ThoughtStep` you push onto history. Cover with a parallel-tool fixture test (§5.3).

2. **`store:false` stateless history = resend prior `Step[]`.** v0 uses `store:false` to preserve TeXRA's existing history/compaction contract. This means the handler keeps the local transcript as `Step[]` and resends `input = [initialUserInputStep, ...allReturnedModelSteps, ...localResultSteps]` each round, with **no** `previous_interaction_id`. Send request-level fields (`system_instruction`, `tools`, `generation_config`, `response_format`) on **every** `create` — they do not persist across stateless requests. `store:false` is incompatible with `background:true` and with `previous_interaction_id`; defer both to a later `store:true` phase.

3. **OpenRouter exclusion.** OpenRouter cannot proxy Interactions. `shouldUseGoogleInteractionsAPI` returns `false` whenever `useOpenRouter` is true (and `compatibilityKeyForConfig` mirrors this). If an `requiresInteractionsAPI:true` model is selected while OpenRouter is active, surface a clear availability error rather than silently falling back to the chat handler (do not let it route through OpenRouter or `generateContent` for an Interactions-only id).

4. **`apiVersion` / endpoint.** The existing Google handler does not set `apiVersion`; the SDK defaults to beta endpoints and REST examples use `/v1beta/interactions`. Do a real-key smoke test (personal key **and** relay key) before hardcoding `apiVersion:'v1'` or assuming relay support. For v0, construct the client identically to the chat handler (`getClient` REUSE) and only override `apiVersion` if the smoke test demands it.

5. **Usage double-counting.** Verify whether Interactions `total_output_tokens` already includes thought tokens. The chat formula adds `candidates + thoughts`; if Interactions' total already includes thoughts, the adapter must NOT add `total_thought_tokens` again (§4.1). Re-validate implicit-cache (`total_cached_tokens`) and reasoning-token accounting against a real response.

6. **Explicit caching unavailable.** `cached_content` exists in the SDK type but explicit caching is documented as a `generateContent`-only feature; do not claim `cached_content` parity. Implicit caching only arrives with the later `store:true` + `previous_interaction_id` phase.

7. **`arguments_delta` parsing.** Streamed tool args arrive as concatenated string fragments in `ArgumentsDelta.arguments`; buffer per `event.index` and `JSON.parse` only at `step.stop`. The discriminator is `"arguments_delta"` (not the guide's `"arguments"`).

8. **`output_text` is lossy.** It joins only the trailing `TextContent` run; with interleaved thoughts/tools/images it omits content. Always walk `steps` for extraction.

9. **Status vs event_type confusion.** `in_progress`/`requires_action` are `InteractionStatus` values surfaced via `InteractionStatusUpdate.status` and `interaction.status_update` events — they are **not** `event_type` values. Switch lifecycle on `event_type`, branch action-needed on `.status`.

10. **Generics drift.** The new handler's `ModelHandler` type parameters change from the chat handler: `M = Step`, `Resp = GoogleGenAIInteraction`, `U = Usage` (snake_case), `Resp`-usage no longer `GenerateContentResponseUsageMetadata`. Ensure `computePrice`/`normalizeUsage`/`extractResponse` signatures match the new `U`/`Resp`, and that `googleInteractionsUsage.ts` types `rawUsage: Usage | null`.

**Files referenced:**

- SDK types: `node_modules/@google/genai/dist/genai.d.ts`
- Tests dir: `src/test-kernel/agent/modelHandlers/`
- Docs: `docs/guide/configuration.md`
