# Implementation Spec: Stateful Google Interactions Handler (store:true + previous_interaction_id chaining)

> **Status:** Implemented (2026-07-04 status sweep). Google Interactions
> server-state chaining now lives on the handler instance via
> `chainedInteractionId`/`sentStepCount`; this spec is retained as implementation
> evidence.

**Handler:** `src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts` (1483 lines, currently STATELESS)
**Precedent:** `src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts`
**SDK:** `@google/genai@2.9.0`

This is the single source of truth. It is grounded on verified facts from the live code in this worktree (signatures below are quoted from the actual files).

---

## 1. Design decision: where chaining state lives

**Verdict: chaining state lives on the HANDLER INSTANCE as private fields. Confirmed and definitive.**

Verified evidence:

- **The handler instance is created once per run and reused across every round.** From the flow-contract report: `runToolUseFlow.ts` builds the `services` object once with `modelHandler` from `input.modelHandler`; `ToolUseCycleNode` spreads that same `services` into every `ToolUseRoundFlow.run()`. The handler is only ever _replaced_ on an explicit model switch (`services.modelHandler = nextHandler`), and on resume-from-snapshot a _new_ handler instance is constructed. It is never recreated between normal rounds.
- **The OpenAI precedent does exactly this** and is the verified blueprint: `private previousResponseId: string | null = null` (line 271), plus a `conversationState` object (`sentMessages`, `cumulativeInputTokens`, `isCompacted`), `private inFlight = false`, all on the instance. Its class doc explicitly documents "THREAD SAFETY: This handler maintains internal state (previousResponseId, ...)".

**Therefore:** mirror OpenAI exactly. Do NOT thread the chain id through `workspaceState`, `Step[]`, snapshots, or any persisted store. Instance fields are correct _because_ a new instance is built on resume — which is precisely what gives us cross-session safety for free (a restored run gets a fresh handler with `chainedInteractionId === null`, so it naturally starts a full resend). See §4.

The flow contract that makes this work (verified):

- Each round, `createResponseImpl` receives `options.messages` = the **FULL accumulated `Step[]` transcript** (not a delta). The flow owns full history in `shared.messages`; the handler computes its own delta internally.
- If the handler compacts, it returns `CreateResponseResult.updatedMessages`; the flow replaces `shared.messages` in place via `replaceMessagesInPlace`. After that the flow keeps appending to the compacted array.

---

## 2. File-by-file edits

### 2.1 `src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts`

Class declaration (verified): `export class ModelHandlerGoogleInteractions extends ModelHandler<...>` (line 154). Base contract (verified in `ModelHandler.ts`):

```ts
// line 707 — overridable template
createResponse(
  options: CreateResponseOptions<M, C>,
): Promise<CreateResponseResult<Resp, M>> {
  return withSdkErrorTag(this.sdkErrorTagger, this.config.provider, () =>
    this.createResponseImpl(options),
  );
}
// line 721 — the override point we already use
protected createResponseImpl(options): Promise<CreateResponseResult<Resp, M>>
```

#### (a) New instance state fields

Add near the top of the class body:

```ts
/**
 * STATEFUL chaining state. Lives on the handler instance because the handler
 * is created once per run and reused across rounds; a restored run gets a
 * fresh instance (chainedInteractionId === null) => fresh full resend.
 * Mirrors ModelHandlerOpenAIResponse (previousResponseId + conversationState).
 */
private chainedInteractionId: string | null = null;

/** Number of Steps already sent to the server (anchors the delta slice). */
private sentStepCount = 0;

/** Set true after a compaction this run; forces a full resend next round. */
private chainCompacted = false;

/** Single-turn guard: concurrent createResponse would race the chain state. */
private inFlight = false;

/** Result of an in-call compaction, returned as updatedMessages. */
private compactionResult?: { compactedMessages: Step[] };
```

Add a private helper mirroring OpenAI's `invalidateResponseChain()`:

```ts
/** Drop the chain so the next request rebuilds from full local history. */
private invalidateChain(): void {
  this.chainedInteractionId = null;
  this.sentStepCount = 0;
  this.chainCompacted = false;
}
```

#### (b) Settings gate

Read the new setting (default `true`) once per call. Mirror OpenAI's `getConfig` usage (`import { getConfig } from '@utils/config/configUtils'`):

```ts
private serverStateEnabled(): boolean {
  return getConfig<boolean>('texra.model.useGoogleInteractionsServerState', true);
}
```

Note: the _parent_ flag `texra.model.useGoogleInteractionsAPI` already selects this handler at all; this new flag only toggles store:true vs store:false _within_ it.

#### (c) `createResponse` override — single-turn guard

The base `createResponse` already wraps `createResponseImpl` in `withSdkErrorTag`. Override it ONLY to add the in-flight guard (mirror OpenAI lines 1147–1169), then delegate:

```ts
override async createResponse(
  options: CreateResponseOptions<Step, GoogleGenAI>,
): Promise<CreateResponseResult<GoogleGenAIInteraction, Step>> {
  if (this.inFlight) {
    throw new Error(
      'modelHandlerGoogleInteractions.createResponse invoked while a prior ' +
        'call is still in flight; this handler is single-turn per instance.',
    );
  }
  this.inFlight = true;
  try {
    return await withSdkErrorTag(this.sdkErrorTagger, this.config.provider, () =>
      this.createResponseImpl(options),
    );
  } finally {
    this.inFlight = false;
  }
}
```

Import `withSdkErrorTag` (already imported in `ModelHandler.ts` line 65; add the import here).

#### (d) `createResponseImpl` changes

Current (verified) hardcodes `store: false`, `input: messages`, no chaining (lines 1198–1237). Rewrite to:

1. **Compute mode once:** `const stateful = this.serverStateEnabled();`
2. **Clear `compactionResult` at entry** (clean retry state): `this.compactionResult = undefined;`
3. **Compaction check (NEW, mirrors OpenAI).** After `applyTokenCountLimit`, when `stateful`, evaluate `this.shouldCompactByInputTokens(estimatedInputTokens)` (base helper, verified line 808; honors `compactionRequested`). If it fires, run `runClientCompaction` (base helper, verified line 831), set `this.compactionResult = { compactedMessages }`, **`this.invalidateChain()`** (compaction replaces history; the old server interaction no longer matches), and use the compacted array as the message base. This is the "clear the chain on compaction" requirement.
4. **Decide input shape:**

```ts
const base = this.compactionResult?.compactedMessages ?? messages;

const shouldSendAll =
  !stateful || this.chainCompacted || this.chainedInteractionId === null;

const inputSteps = shouldSendAll ? base : base.slice(this.sentStepCount);
```

5. **Build params with store + previous_interaction_id:**

```ts
const store = stateful;
const previousId =
  stateful && !shouldSendAll ? this.chainedInteractionId! : undefined;

const params = {
  model: this.config.fullName,
  input: inputSteps,
  stream: useStreaming, // true/false branch as today
  store,
  ...(previousId && { previous_interaction_id: previousId }),
  ...(systemPrompt && { system_instruction: systemPrompt }),
  ...(interactionsTools && { tools: interactionsTools }),
  generation_config: generationConfig,
};
```

(Verified SDK: `CreateModelInteraction.store?: boolean` line 2385, `previous_interaction_id?: string` line 2411.)

6. **Capture the id after the response.** In `consumeStream` (streaming) and the non-streaming branch, after a successful completed response, call a new `finalizeChain(response, base.length, shouldSendAll)`:

```ts
private finalizeChain(
  response: GoogleGenAIInteraction,
  totalStepCount: number,
  sentAll: boolean,
): void {
  if (!this.serverStateEnabled()) return;
  const safeToChain =
    response.status === 'completed' && typeof response.id === 'string';
  if (safeToChain) {
    this.chainedInteractionId = response.id;
    this.sentStepCount = totalStepCount;   // server now holds the full transcript
    if (sentAll) this.chainCompacted = false; // a full resend re-establishes a clean chain
  } else {
    this.invalidateChain();
  }
}
```

`consumeStream` already has `response.id`/`response.status` (verified lines 1323–1332); add the `finalizeChain` call before `return { response }`, and thread `totalStepCount`/`sentAll` into `consumeStream`'s signature. The non-streaming branch calls `finalizeChain` then returns `{ response, ...(this.compactionResult && { updatedMessages: this.compactionResult.compactedMessages }) }`.

7. **Return updatedMessages on compaction.** Both branches must return `updatedMessages: this.compactionResult.compactedMessages` when compaction ran this call (so the flow's `replaceMessagesInPlace` swaps in the compacted history; verified flow behavior).

8. **Expired/invalid-id recovery + retry (NEW).** Wrap the SDK call. On a stale-chain error (see §3 detection), if `this.chainedInteractionId !== null` and we have NOT already retried this call:

```ts
if (isStaleInteractionChainError(error) && this.chainedInteractionId) {
  this.logger.debug(
    `Clearing chainedInteractionId=${this.chainedInteractionId} (stale/expired) — retrying with full resend`,
  );
  this.invalidateChain();
  return this.createResponseImpl(options); // one internal retry; chain now null => full resend
}
```

Guard against infinite recursion: because `invalidateChain()` sets `chainedInteractionId = null`, the retry takes the `shouldSendAll` path and cannot hit the same stale-id error again. The existing `attachPartialText` catch (verified lines 1238–1246) stays as the outer fallback.

#### (e) `estimateTokenCount`

Verified override at line 303. When `stateful && chainedInteractionId && !shouldSendAll`, the local `messages` over-counts (server holds most of it). Two options — choose the conservative one:

- **Conservative (recommended for v1):** keep estimating on the FULL local `messages`. This over-estimates input under chaining, which only makes `applyTokenCountLimit` _more_ cautious (it shrinks max_output_tokens). It never under-budgets. Add a code comment that exact server-side token accounting under chaining is a `// SMOKE-TEST` unknown (see §7).

Do NOT pass `previous_interaction_id` into a token-count call — the SDK `.d.ts` exposes no token-count endpoint analogous to OpenAI's `inputTokens.count`; estimation stays local.

### 2.2 `src/agent/modelHandlers/google/googleInteractionsUsage.ts`

Token semantics under chaining (verified mapping lines 49–74):

```ts
const promptTokens = usage.total_input_tokens ?? 0; // line 56
const toolUseTokens = usage.total_tool_use_tokens ?? 0; // line 57
const visibleOutputTokens = usage.total_output_tokens ?? 0;
const reasoningTokens = usage.total_thought_tokens ?? 0;
const inputTokens = promptTokens + toolUseTokens;
```

**No functional change required.** The function reads whatever the server reports. Under chaining the server is expected to report the _delta_ input (smaller numbers → lower cost automatically). Add ONE doc comment flagging the open question:

```ts
// SMOKE-TEST (cannot verify offline): under previous_interaction_id chaining,
// it is UNCONFIRMED whether total_input_tokens reports only the new turn's
// input or the cumulative server-side context. If cumulative, per-round input
// costs will look unexpectedly large. Verify with a real-key two-round run and
// adjust here only if the server double-counts. (genai.d.ts Usage line 13956
// comment is silent on chaining.)
```

`total_cached_tokens` stays a subset of `total_input_tokens` (verified comment line 86); no change.

### 2.3 `src/shared/schemas/coreSettings.ts`

Three edits (per the settings-plan report, verified site pattern — `useGoogleInteractionsAPI` already present at the same three sites):

1. `DEFAULT_CORE_SETTINGS.model` — add `useGoogleInteractionsServerState: true,` (after `useGoogleInteractionsAPI`).
2. `CoreSettingsShape.model` — add `useGoogleInteractionsServerState: z.boolean().prefault(DEFAULT_CORE_SETTINGS.model.useGoogleInteractionsServerState),`.
3. `CORE_SETTING_PATHS` — add `'model.useGoogleInteractionsServerState',` after `'model.useGoogleInteractionsAPI',`.

### 2.4 `packages/extension/package.json` (`contributes.configuration`)

Add after the `useGoogleInteractionsAPI` property:

```json
"texra.model.useGoogleInteractionsServerState": {
  "type": "boolean",
  "default": true,
  "description": "Store Google Interactions conversation state server-side via previous_interaction_id chaining (sends only the new turn each round). Enabled by default. Disable to fall back to stateless mode (resend the full transcript each round with store:false).",
  "scope": "resource"
}
```

### 2.5 `scripts/extension-package-invariants.snapshot.json`

Mirror the package.json property in the snapshot's `manifest.contributes.configuration` block (keys in the snapshot's existing alpha/structural order — `default`, `description`, `scope`, `type`):

```json
"texra.model.useGoogleInteractionsServerState": {
  "default": true,
  "description": "Store Google Interactions conversation state server-side via previous_interaction_id chaining (sends only the new turn each round). Enabled by default. Disable to fall back to stateless mode (resend the full transcript each round with store:false).",
  "scope": "resource",
  "type": "boolean"
}
```

(If a separate settings _provider/registry_ file surfaces this flag to the settings webview — grep `useGoogleInteractionsAPI` across `packages/extension/src/settingsView` and `src/shared` — add the same one-line entry there. Verify by grep before writing; do not invent a file.)

### 2.6 Tests

See §6.

---

## 3. The chaining algorithm (concrete pseudocode)

```
createResponseImpl(options):
  stateful = getConfig('texra.model.useGoogleInteractionsServerState', default=true)
  this.compactionResult = undefined
  estimate = estimateTokenCount(messages)         # full local transcript (conservative)
  applyTokenCountLimit(estimate -> shrink max_output_tokens)

  # --- COMPACTION (only when stateful) ---
  if stateful and shouldCompactByInputTokens(estimate):     # base helper; honors compactionRequested
      { compactedMessages, didCompact } = runClientCompaction(messages, ...)
      if didCompact:
          this.compactionResult = { compactedMessages }
          this.invalidateChain()                  # chain id no longer matches server history
  base = this.compactionResult?.compactedMessages ?? messages

  # --- INPUT SHAPE ---
  shouldSendAll = (not stateful)
               or this.chainCompacted
               or this.chainedInteractionId is null
  inputSteps = shouldSendAll ? base : base.slice(this.sentStepCount)
  previousId = (stateful and not shouldSendAll) ? this.chainedInteractionId : undefined

  params = { model, input: inputSteps, stream, store: stateful,
             previous_interaction_id?: previousId, system_instruction?, tools?, generation_config }

  try:
      response = await client.interactions.create(params)   # streaming -> consumeStream
  catch error:
      if isStaleInteractionChainError(error) and this.chainedInteractionId:
          this.invalidateChain()                  # => next pass shouldSendAll = true
          return createResponseImpl(options)       # ONE internal retry, cannot re-hit stale id
      attachPartialText(error); throw error

  # --- CAPTURE / REUSE ---
  finalizeChain(response, totalStepCount = base.length, sentAll = shouldSendAll):
      if not stateful: return
      if response.status == 'completed' and typeof response.id == 'string':
          this.chainedInteractionId = response.id
          this.sentStepCount = base.length         # server now holds full transcript
          if sentAll: this.chainCompacted = false  # clean chain re-established
      else:
          this.invalidateChain()                   # incomplete/failed => don't chain

  return { response, updatedMessages?: this.compactionResult?.compactedMessages }
```

**First request:** `chainedInteractionId === null` ⇒ `shouldSendAll = true` ⇒ `input = base` (full), `store: true`, NO `previous_interaction_id`. After: capture id, `sentStepCount = base.length`.

**Continuation:** `chainedInteractionId !== null`, `chainCompacted === false` ⇒ `shouldSendAll = false` ⇒ `input = base.slice(sentStepCount)` (only Steps appended since last send — the new user/tool-result turn), `store: true`, `previous_interaction_id = chainedInteractionId`. After: capture new id, `sentStepCount = base.length`.

**Delta definition:** "new Steps since last send" = `base.slice(this.sentStepCount)`. `sentStepCount` is the length of the transcript at the moment the previous response completed. The flow appends the assistant turn + tool results + next user follow-up to `shared.messages` between rounds (verified flow contract), so the slice is exactly those appended Steps.

**Compaction:** clears the chain (`invalidateChain`) AND returns `updatedMessages`; next round `chainedInteractionId === null` ⇒ full resend of the compacted transcript, re-establishing a fresh chain.

**Stale/expired id:** detected in catch, `invalidateChain` + one internal retry with full resend.

**`isStaleInteractionChainError(error)` detection (best-effort; exact match is a SMOKE-TEST unknown):** Match on the SDK `ErrorT` shape (`error.code` line 3585, `error.message` line 3589) and HTTP status. Treat as stale if any of: HTTP status `404`/`410`; `error.code` ∈ `{ 'NOT_FOUND', 'INVALID_ARGUMENT', 'FAILED_PRECONDITION' }`; or `error.message` matching `/previous_interaction_id|interaction .*(not found|expired|invalid)/i`. Implement as a small predicate next to the handler with a `// SMOKE-TEST: exact error code for stale previous_interaction_id is unconfirmed from genai.d.ts` comment, and keep the matcher permissive but anchored to the `previous_interaction_id`/interaction wording so it never swallows unrelated 404s.

---

## 4. History restore & cross-session safety

**Guarantee: a restored run never sends a dead `previous_interaction_id`. It is structurally impossible given instance-field state.**

Mechanism (verified): on resume-from-snapshot, `runToolUseFlow` constructs a **new** `ModelHandlerGoogleInteractions` from `input.modelHandler`. A fresh instance has `chainedInteractionId === null`, `sentStepCount === 0`, `chainCompacted === false`. The first `createResponseImpl` after restore therefore takes `shouldSendAll = true` ⇒ full resend of the restored transcript with `store: true` and NO `previous_interaction_id`, and only _then_ establishes a brand-new chain from the new response id. The old (possibly expired, ~weeks-TTL) interaction id is never referenced because it was never persisted anywhere — it only ever existed on the now-discarded instance.

Belt-and-suspenders: even in the unlikely event a stale id were somehow present, the §3 catch path (`isStaleInteractionChainError` → `invalidateChain` → retry full) recovers transparently.

**Model switch within a live run** (verified `services.modelHandler = nextHandler`): also produces a fresh handler ⇒ fresh chain ⇒ first call full resend. Correct by the same mechanism.

---

## 5. What stays the same (don't break the verified stateless tests)

- When `useGoogleInteractionsServerState === false`, `serverStateEnabled()` returns false ⇒ `store: false`, `shouldSendAll = true` always, `previous_interaction_id` never set, no compaction-clear bookkeeping, no chain capture. This is **byte-identical to today's behavior** (verified current code: `store: false`, `input: messages`). All existing stateless tests must keep passing unchanged when the setting is off.
- `consumeStream` SSE assembly (`interaction.created` / `step.*` / `interaction.completed` / `error`), `finalizeSteps`, `buildAssistantTurnSteps`, `buildFunctionResultStep`, thought-signature round-trip, `extractResponse`, `processThinkingBlock` — all unchanged.
- `initializeMessages` / `createRoundMessages` / `createUserFollowUpMessages` / `createToolUseFollowUpMessages` / `createBatchedToolUseFollowUpMessages` — unchanged. The flow still owns the full `Step[]`; chaining is purely a transport-layer optimization inside `createResponseImpl`.
- `googleInteractionsUsage.ts` numeric behavior — unchanged (only a doc comment added).
- Headless / `--print` / JSON output parity — unchanged (this is handler-internal).

---

## 6. Test plan

New/changed suite alongside the existing Google Interactions handler tests (`src/test-kernel/...` — mirror the existing `modelHandlerGoogleInteractions` spec location; reuse its fake `client.interactions.create` + fake SSE stream).

| #   | Test                                                  | Asserts                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | **First request shape (stateful on)**                 | First `createResponse` with setting=on sends `store: true`, `input.length === messages.length` (full), and NO `previous_interaction_id`.                                                                                                                                                                                     |
| T2  | **Continuation sends delta**                          | After T1 captures an id, append N new Steps; second call sends `previous_interaction_id === <captured id>`, `store: true`, and `input` equals exactly the appended slice (`base.slice(sentStepCount)`), length === N.                                                                                                        |
| T3  | **Id capture + reuse**                                | After a completed response with `id: 'int_abc'`, `chainedInteractionId === 'int_abc'` and `sentStepCount === base.length`; next call reuses `int_abc`.                                                                                                                                                                       |
| T4  | **Incomplete/failed response does not chain**         | Response with `status !== 'completed'` ⇒ chain invalidated; next call is a full resend with no `previous_interaction_id`.                                                                                                                                                                                                    |
| T5  | **Expired/invalid id fallback + retry**               | Fake create rejects first call with a stale-chain error (404 / `code: NOT_FOUND`) when `previous_interaction_id` is present, succeeds on retry. Assert: handler retried exactly once, retry sent full `input` with NO `previous_interaction_id`, returned the successful response, chain re-established from the retry's id. |
| T6  | **Compaction clears chain + returns updatedMessages** | Force `requestCompaction()` (sets `compactionRequested`); assert `runClientCompaction` ran, `updatedMessages === compactedMessages`, `chainedInteractionId === null` at the moment of the create call (full resend), and a fresh chain is established afterward.                                                             |
| T7  | **Setting off ⇒ stateless (regression)**              | With setting=off every call sends `store: false`, full `input`, no `previous_interaction_id`; no chain state mutates. (This is the existing stateless test — keep it green.)                                                                                                                                                 |
| T8  | **Restore safety**                                    | Construct a fresh handler instance (simulating resume) with the same transcript; assert the first call is a full resend with no `previous_interaction_id` even though a prior instance had captured an id.                                                                                                                   |
| T9  | **Single-turn guard**                                 | Calling `createResponse` while a prior call is in flight throws the single-turn error; the guard resets in `finally` so a subsequent serial call succeeds.                                                                                                                                                                   |
| T10 | **Default is on**                                     | `coreSettings` default for `useGoogleInteractionsServerState` is `true`; schema `prefault` round-trips; `CORE_SETTING_PATHS` includes it. (Pure schema test.)                                                                                                                                                                |

**REQUIRES a real-key smoke test (cannot verify offline — flag in code with `// SMOKE-TEST` and call out in the PR body):**

- **S1 — Token accounting under chaining:** does `usage.total_input_tokens` report the delta or the cumulative server context? (genai.d.ts is silent.) Determines whether `googleInteractionsUsage.ts` needs adjustment.
- **S2 — Exact stale-id error shape:** the real HTTP status / `error.code` / message string when a `previous_interaction_id` is expired or unknown. Tune `isStaleInteractionChainError` to the observed shape.
- **S3 — End-to-end chain correctness:** a real ≥3-round tool-use run produces coherent output with delta-only sends (server actually retained history), and `store: true` interactions are retrievable / chain across rounds.

---

## 7. Risks / gotchas

1. **Stale-id error shape is unconfirmed (S2).** The SDK `.d.ts` exposes `ErrorT { code?, message? }` (lines 3585/3589) and `InteractionStatus` has no `expired` member (line 7620). The predicate is best-effort until the smoke test. _Mitigation:_ keep the matcher anchored to `previous_interaction_id`/interaction wording so it never misclassifies unrelated 404s, and rely on the full-resend retry being idempotent.
2. **Token semantics under chaining unconfirmed (S1).** If the server reports cumulative input under chaining, per-round costs will look large but correct; if it reports the delta, costs drop. The conservative local estimate (§2.1e) never under-budgets either way, so correctness (not just cost) is safe.
3. **Infinite-retry safety.** The expired-id retry is bounded because `invalidateChain()` sets `chainedInteractionId = null` ⇒ retry path is `shouldSendAll` ⇒ no `previous_interaction_id` ⇒ cannot re-trigger a stale-id error. Do not add a second internal retry.
4. **Compaction + chaining interaction.** Compaction MUST `invalidateChain()` (server still holds the _pre_-compaction history under the old id; chaining onto it would double the context). Verified analog: OpenAI clears `previousResponseId` immediately after compaction (line 817).
5. **Reasoning/thought signatures round-trip.** Today the handler resends thought steps with signatures verbatim each round (`buildAssistantTurnSteps`). Under delta-only sends, the _server_ now holds prior thought steps; the delta slice must NOT re-send already-sent assistant/thought steps (it won't — the slice starts at `sentStepCount`, past them). The new user/tool-result turn is all that's sent. This is correct but is exactly what S3 must confirm end-to-end.
6. **Single-turn guard is mandatory.** Concurrent calls would corrupt `chainedInteractionId`/`sentStepCount`. The override + `inFlight` flag (mirroring OpenAI lines 1153–1158) makes the race fail loudly instead of silently corrupting the chain.
7. **`background` / `webhook_config` (SDK lines 2389 / 14495) are out of scope** for this change; `store: true` unlocks them but they are deferred. Do not wire them now.
8. **Compat key unchanged.** Mode is a per-turn runtime decision; the same handler key serves both modes (verified settings-plan report). No history-format migration needed.

---

### Verified

- `src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts` — class decl (154), `createResponseImpl` body with hardcoded `store: false` / `input: messages` (1163–1247), `consumeStream` id/status assembly (1253–1341), `estimateTokenCount` override (303), no existing chaining symbols.
- `src/agent/modelHandlers/ModelHandler.ts` — overridable `createResponse` template + `withSdkErrorTag` (707–711), `createResponseImpl` override point (721), `supportsManualCompaction` (499), `compactionRequested`/`requestCompaction` (508/511), `shouldCompactByInputTokens` (808), `runClientCompaction` (831), `getCompactionThresholdPercent` (795).
- `src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts` — instance state precedent (`previousResponseId` 271, `inFlight` guard 1150+, `getConfig` 236, compaction chain-clear 817), confirming the instance-field design and single-turn override pattern.
- `src/agent/modelHandlers/google/googleInteractionsUsage.ts` — token mapping (49–74), `total_input_tokens` (56), cached-subset comment (86), exports `computeGoogleInteractionsPrice`/`normalizeGoogleInteractionsUsage`.
- Cross-checked against the five research reports for the flow contract (handler reuse across rounds; new instance on resume; full `Step[]` per round; `updatedMessages` replace-in-place) and the SDK surface (`store` 2385, `previous_interaction_id` 2411, `Interaction.id` 6955, `InteractionSseEventInteraction.id` 7572, `ErrorT` 3585/3589, `Usage.total_input_tokens` 13956).
