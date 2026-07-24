# Implementation Spec: BACKGROUND-mode execution for `ModelHandlerGoogleInteractions`

> **Status:** Implemented (2026-07-04 status sweep). The Google Interactions
> handler now supports `background:true`, polling through `interactions.get`, and
> abort-time `interactions.cancel`; this spec is retained as implementation
> evidence.

**Handler:** `src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts`
**Reference:** `src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts`

This spec adds an asynchronous BACKGROUND execution path: submit a long-running interaction with `background: true` (which forces `store: true`), poll `interactions.get(id)` until a terminal status, surface progress, and cancel via `interactions.cancel(id)` on abort. It composes with the existing `previous_interaction_id` chaining (`finalizeChain` / `invalidateChain`) and compaction.

---

## 1. When background activates

### 1.1 The exact gate

Background mode requires **server-side state** because the only way to retrieve a long-running interaction's result is `interactions.get(id)`, which needs the interaction persisted (`store: true`). Therefore background is gated on **both** the user toggle **and** stateful mode:

```typescript
private useBackgroundMode(stateful: boolean): boolean {
  return (
    this.backgroundModeSupported &&
    stateful &&
    getConfig<boolean>('texra.model.useBackgroundResponses', true)
  );
}
```

- `this.backgroundModeSupported` — set to `true` on this handler (overriding the base default of `false` at `ModelHandler.ts:131`). This mirrors `ModelHandlerOpenAIResponse.backgroundModeSupported = true` (line 250).
- `stateful` — the existing `this.serverStateEnabled()` result (handler line 271–276; reads `texra.model.useGoogleInteractionsServerState`, default `true`). **This is the load-bearing difference from OpenAI**: OpenAI always sends `store: true`, so its gate is only the toggle + GPT-family + workflow eligibility. Google's handler has a real stateless mode (`store: false`), and background is _categorically impossible_ there — see §5.
- `texra.model.useBackgroundResponses` — the existing shared toggle (default `true`), reused as-is (see §2.3).

**Eligibility note (deliberate divergence from OpenAI):** OpenAI adds `isBackgroundModeEligible()` = `isGptFamilyModelName(...) && isWorkflowMode()` (lines 262–264) to exclude tool-use agents (which rely on per-step streaming) and non-GPT models. For v0 of the Google handler, **do not** replicate the model-name family check (there is no `isGeminiBackgroundEligible` analogue and Interactions background applies to all Interactions-capable Gemini models). **Do** gate on workflow mode to match OpenAI's exclusion of tool-use loops, since background polling is a poor fit for the tool-use turn cadence:

```typescript
private isBackgroundModeEligible(): boolean {
  return this.isWorkflowMode();   // base ModelHandler.ts:201, AgentCategory.Workflow
}
```

Final gate:

```typescript
private useBackgroundMode(stateful: boolean): boolean {
  return (
    this.backgroundModeSupported &&
    stateful &&
    this.isBackgroundModeEligible() &&
    getConfig<boolean>('texra.model.useBackgroundResponses', true)
  );
}
```

### 1.2 Interaction with `getStreamingConfig`

Background replaces streaming. The handler currently computes `const useStreaming = this.getStreamingConfig();` (handler line 1400). Mirror OpenAI's override (lines 222–224):

```typescript
public override getStreamingConfig(): boolean {
  return !this.isBackgroundModeActive() && super.getStreamingConfig();
}

public override isBackgroundModeActive(): boolean {
  return this.useBackgroundMode(this.serverStateEnabled());
}
```

Because `getStreamingConfig()` returns `false` when background is active, the existing `useStreaming` branch (handler line 1424) becomes unreachable while background is on. The dispatch in `createResponseImpl` resolves the three paths explicitly and definitively:

```typescript
const stateful = this.serverStateEnabled(); // already computed at line 1335
const useBackground = this.useBackgroundMode(stateful);
const useStreaming = !useBackground && this.getStreamingConfig();
```

Definitive ordering: **background > streaming > non-streaming**. When `useBackground` is true, neither streaming nor the plain non-streaming `create` path runs.

---

## 2. File-by-file edits

### 2.1 `src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts`

**(a) Enable background support and SDK type aliases.** Add near the existing `INLINE_MEDIA_LIMIT_BYTES` static and the SDK aliases (lines 99–111):

```typescript
type GetInteractionByIdRequest = Interactions.GetInteractionByIdRequest;
type InteractionStatus = Interactions.InteractionStatus;
```

Add the `backgroundModeSupported` override and poll constants to the class body (alongside `INLINE_MEDIA_LIMIT_BYTES` at line 235):

```typescript
protected override backgroundModeSupported = true;

private static readonly BACKGROUND_POLL_INTERVAL_MS = 5000;          // see §7.1
private static readonly BACKGROUND_MAX_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * Non-terminal Interaction statuses — polling continues while the status is in
 * this set. `requires_action` is deliberately EXCLUDED: in workflow (non-tool)
 * background mode it is unexpected and treated as terminal so the loop never
 * hangs (see §7). Mirrors ModelHandlerOpenAIResponse.BACKGROUND_PENDING_STATUSES
 * (['queued','in_progress']); Interactions has no 'queued' member.
 */
private static readonly BACKGROUND_PENDING_STATUSES:
  readonly InteractionStatus[] = ['in_progress'];

/**
 * Id of the background interaction currently being polled, so an abort handler
 * can cancel it and the in-flight guard's finally can confirm cleanup. Mirrors
 * ModelHandlerOpenAIResponse.pendingBackgroundResponseId.
 */
private pendingBackgroundInteractionId: string | null = null;

private clearPendingBackgroundInteraction(): void {
  this.pendingBackgroundInteractionId = null;
}
```

> **SMOKE-TEST S-BG1 (covered by report 2 §4):** `InteractionStatus = "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "incomplete" | "budget_exceeded" | (string & {})` (genai.d.ts line 7620). There is **no** `"queued"` member, and the initial status returned by a `background: true` create is undocumented in the `.d.ts`. The pending set therefore contains only `in_progress`; treat every other status as terminal. If a real-key run shows the initial status is something else (e.g. a string literal not in the union via the `(string & {})` escape hatch), add it to `BACKGROUND_PENDING_STATUSES`.

**(b) Override the streaming/background hooks** (insert near the capability getters, e.g. after `serverStateEnabled` at line 276):

```typescript
public override isBackgroundModeActive(): boolean {
  return this.useBackgroundMode(this.serverStateEnabled());
}

public override getStreamingConfig(): boolean {
  return !this.isBackgroundModeActive() && super.getStreamingConfig();
}

private isBackgroundModeEligible(): boolean {
  return this.isWorkflowMode();
}

private useBackgroundMode(stateful: boolean): boolean {
  return (
    this.backgroundModeSupported &&
    stateful &&
    this.isBackgroundModeEligible() &&
    getConfig<boolean>('texra.model.useBackgroundResponses', true)
  );
}
```

**(c) Reset the pending id in `invalidateChain`** (handler line 279) so a dropped chain never strands a pending id:

```typescript
private invalidateChain(): void {
  this.chainedInteractionId = null;
  this.sentStepCount = 0;
  this.clearPendingBackgroundInteraction();
}
```

**(d) Add the background branch in `createResponseImpl`.** Insert the dispatch decision after `stateful` is computed (line 1335) and the background branch **before** the `if (useStreaming)` block (line 1424), inside the existing `try` (line 1423). The shared request shape (`commonParams`, line 1410) and `requestOptions` (line 1421) are reused verbatim.

Replace the dispatch around line 1400:

```typescript
const useBackground = this.useBackgroundMode(stateful);
const useStreaming = !useBackground && this.getStreamingConfig();
```

Inside the `try` block (line 1423), prepend the background branch:

```typescript
if (useBackground) {
  const result = await this.executeBackgroundPath(
    client,
    commonParams,
    base.length,
    stateful,
    endTag,
    signal,
  );
  return withUpdated(result);
}

if (useStreaming) {
  /* ...existing streaming branch unchanged... */
}
/* ...existing non-streaming branch unchanged... */
```

> The stale-chain `catch` (handler lines 1450–1465) already wraps the whole `try`. Because `commonParams` carries `previous_interaction_id` (line 1414), a stale-id error during the background **submit** is caught by `isStaleInteractionChainError`, `invalidateChain()` runs (now also clearing the pending id), and `createResponseImpl` re-runs — re-entering the background path with a full resend and no chain. No change needed to the catch.

**(e) Add the background methods.** Place after `consumeStream` (line 1615). The cancellation registration uses `AbortSignal.addEventListener` (fire-once) and a `finally` that removes the listener and resets `pendingBackgroundInteractionId`:

```typescript
/**
 * BACKGROUND path: submit with background:true + store:true, capture the id,
 * poll interactions.get(id) until a terminal status, finalize the chain off the
 * completed interaction, and surface the same CreateResponseResult shape the
 * streaming / non-streaming paths return. Cancels the in-flight interaction on
 * abort. Mirrors ModelHandlerOpenAIResponse.executeNonStreamingPath +
 * waitForBackgroundCompletion.
 */
private async executeBackgroundPath(
  client: GoogleGenAI,
  commonParams: CreateModelInteractionParamsNonStreaming, // commonParams w/o stream
  totalStepCount: number,
  stateful: boolean,
  endTag: string | undefined,
  signal: AbortSignal | undefined,
): Promise<CreateResponseResult<GoogleGenAIInteraction, Step>> {
  // Background REQUIRES server-side state — assert the gate's invariant.
  if (!stateful) {
    throw new Error(
      'Background mode requires server-side state (store:true); refusing to ' +
        'submit a background interaction in stateless mode.',
    );
  }

  const requestOptions = signal ? { fetchOptions: { signal } } : undefined;

  // Submit. background:true forces store:true (already true under `stateful`).
  // The submit still carries the delta `input` + previous_interaction_id from
  // commonParams, so chaining composes with background unchanged.
  const submitParams: CreateModelInteractionParamsNonStreaming = {
    ...commonParams,
    stream: false,
    store: true,
    background: true,
  };
  logProgressStatus(
    this.logger,
    'Running Google Interactions in background mode; polling for completion ' +
      '(this may take longer than usual).',
  );
  const submitted = (await client.interactions.create(
    submitParams,
    requestOptions,
  )) as unknown as GoogleGenAIInteraction;

  const completed = await this.pollBackgroundInteraction(
    client,
    submitted,
    signal,
  );

  // Capture the chain anchor from the COMPLETED polled interaction (NOT the
  // submit), so the next turn chains onto a server-retained, completed id.
  this.finalizeChain(completed, totalStepCount, stateful);
  return { response: completed };
}

private isBackgroundPending(interaction: GoogleGenAIInteraction): boolean {
  return ModelHandlerGoogleInteractions.BACKGROUND_PENDING_STATUSES.includes(
    interaction.status as InteractionStatus,
  );
}

/**
 * Poll interactions.get(id) until a terminal status. Throws on a non-completed
 * terminal status, on timeout, and on abort (after cancelling the interaction).
 */
private async pollBackgroundInteraction(
  client: GoogleGenAI,
  initial: GoogleGenAIInteraction,
  signal: AbortSignal | undefined,
): Promise<GoogleGenAIInteraction> {
  const interactionId = initial.id;
  if (typeof interactionId !== 'string') {
    // No id ⇒ cannot poll. Trust the submit response (its status drives
    // finalizeChain, which invalidates the chain if not 'completed').
    this.logger.warn(
      'Background submit returned no interaction id; skipping polling.',
    );
    return initial;
  }

  this.pendingBackgroundInteractionId = interactionId;
  const onAbort = () => {
    // Fire-and-forget cancel; do NOT await inside the listener (it runs
    // synchronously off the signal). delay()/get() below reject with AbortError,
    // which the catch translates into the user-abort throw.
    void this.cancelBackgroundInteraction(client, interactionId);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const pollInterval =
    ModelHandlerGoogleInteractions.BACKGROUND_POLL_INTERVAL_MS;
  const maxDuration =
    ModelHandlerGoogleInteractions.BACKGROUND_MAX_DURATION_MS;
  const startTime = Date.now();
  let current = initial;
  let pollCount = 0;

  try {
    while (this.isBackgroundPending(current)) {
      pollCount += 1;
      try {
        await delay(pollInterval, { signal });
      } catch (err) {
        if (isUserAbort(err)) {
          this.logger.debug(
            `Background polling aborted for interaction ${interactionId} ` +
              `while waiting (poll ${pollCount}).`,
          );
        }
        throw err; // cancel already requested via onAbort
      }

      if (Date.now() - startTime > maxDuration) {
        throw new Error(
          `Background interaction ${interactionId} exceeded maximum polling ` +
            `duration of ${maxDuration} ms. Cancel it with ` +
            `client.interactions.cancel("${interactionId}").`,
        );
      }

      const getParams: GetInteractionByIdRequest = {
        id: interactionId,
        stream: false,
      };
      try {
        // get() overload: (id, params?: InteractionGetParamsNonStreaming|null,
        //   options?) => Promise<GoogleGenAIInteraction>  (genai.d.ts 4609)
        current = (await client.interactions.get(
          interactionId,
          getParams,
          requestOptionsFromSignal(signal),
        )) as unknown as GoogleGenAIInteraction;
      } catch (err) {
        this.sdkErrorTagger(err, this.config.provider);
        if (isUserAbort(err)) throw err;
        // Transient poll error (5xx/429/network): rethrow so PocketFlow's
        // retry layer re-enters createResponse. The fresh instance / chain
        // bookkeeping resubmits; the orphaned background job ages out
        // server-side. (No resume path in v0 — see §7.4.)
        throw err;
      }
      this.logger.debug(
        `Background poll ${pollCount} for ${interactionId}: ` +
          `status=${current.status ?? 'unknown'}`,
      );
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    this.clearPendingBackgroundInteraction();
  }

  if (current.status === 'completed') return current;

  // Terminal non-completed: failed / cancelled / incomplete / budget_exceeded.
  const status = current.status ?? 'unknown';
  this.logger.error(
    `Background interaction ${interactionId} ended with status "${status}".`,
  );
  const err = new Error(
    `Google Interactions background interaction ${interactionId} ended with ` +
      `status "${status}".`,
  );
  this.sdkErrorTagger(err, this.config.provider);
  throw err;
}

/** Cancel the in-flight background interaction (best-effort). */
private async cancelBackgroundInteraction(
  client: GoogleGenAI,
  interactionId: string,
): Promise<void> {
  try {
    // cancel(id, params?: {api_version?}|null, options?) => Promise<...>
    // (genai.d.ts 4615)
    await client.interactions.cancel(interactionId);
    this.logger.debug(`Cancelled background interaction ${interactionId}.`);
  } catch (err) {
    this.logger.warn(
      `Failed to cancel background interaction ${interactionId}: ` +
        getSdkErrorMessage(err),
    );
  }
}
```

Helper for request options (matches the handler's existing `fetchOptions.signal` convention at line 1421):

```typescript
function requestOptionsFromSignal(signal: AbortSignal | undefined) {
  return signal ? { fetchOptions: { signal } } : undefined;
}
```

**(f) New imports.** Add to the existing import groups:

- `import { logProgressStatus } from '@agent/trace';` (already importing `logSdkError` from `@agent/trace`; add `logProgressStatus`).
- `import { delay } from '@utils/core';` (re-exported from `@utils/core` per `src/utils/core/index.ts:27`).
- `import { isUserAbort } from '@common/errors/sdkErrorUtils';` (already importing `attachPartialText`, `takeTail`, etc. from `@common/errors/sdkErrorUtils`; add `isUserAbort`). `isUserAbort` is defined in `src/common/errors/sdkError/errorPatterns.ts:18` and re-exported via `sdkErrorUtils`.

### 2.2 No-op: the gate runs **inside** `createResponseImpl`

`useBackground` reads live config (`getConfig`), so no constructor wiring is needed beyond `backgroundModeSupported = true`. The `inFlight` guard (handler lines 1297–1312) already spans the whole `createResponseImpl`, so it holds for the entire poll loop, preventing concurrent calls from racing `chainedInteractionId` / `sentStepCount` / `pendingBackgroundInteractionId` (see §4).

### 2.3 `useBackgroundResponses` setting — **reuse, no edit**

The setting **already exists** in `src/shared/schemas/coreSettings.ts` at all three required sites (verified):

- `DEFAULT_CORE_SETTINGS.model.useBackgroundResponses: true` — line 84
- `CoreSettingsShape`: `useBackgroundResponses: z.boolean().prefault(DEFAULT_CORE_SETTINGS.model.useBackgroundResponses)` — lines 336–338
- `CORE_SETTING_PATHS`: `'model.useBackgroundResponses'` — line 575

**No changes to `coreSettings.ts`, `package.json`, or the invariants snapshot.** The key `texra.model.useBackgroundResponses` is the same string OpenAI reads (line 236) and the new gate reads. Confirm `package.json` already declares the `texra.model.useBackgroundResponses` configuration property (it must, since OpenAI ships it); if a grep shows it missing, add it there + regenerate the invariants snapshot — but the OpenAI handler already shipping this toggle implies it is present.

### 2.4 Tests

New file `src/test-kernel/agent/modelHandlers/GoogleInteractionsBackground.vitest.ts`, modeled on `GoogleInteractionsChaining.vitest.ts` (same `createConfig`, `silentLogger`, `userStep` helpers; `AgentCategory.Workflow` must be set so `isWorkflowMode()` is true — call `handler.setAgentCategory(AgentCategory.Workflow)`). See §6.

---

## 3. The background algorithm (concrete pseudocode)

```
createResponseImpl(options):
  ... existing: compute stateful, generationConfig, tools ...
  ... existing: applyTokenCountLimit ...
  ... existing: compaction (stateful only) → may invalidateChain() ...
  base       = compactionResult?.compactedMessages ?? messages
  shouldSendAll = !stateful || chainedInteractionId === null
  inputSteps    = shouldSendAll ? base : base.slice(sentStepCount)
  previousId    = (stateful && !shouldSendAll) ? chainedInteractionId : undefined
  commonParams  = { model, input: inputSteps, store: stateful,
                    previous_interaction_id?: previousId,
                    system_instruction?, tools?, generation_config }

  useBackground = useBackgroundMode(stateful)      // §1.1
  useStreaming  = !useBackground && getStreamingConfig()

  try:
    if useBackground:
      result = executeBackgroundPath(client, commonParams, base.length, stateful, endTag, signal)
      return withUpdated(result)            // withUpdated attaches updatedMessages on compaction
    if useStreaming: ... (unchanged) ...
    ... non-streaming (unchanged) ...
  catch error:
    if stateful && chainedInteractionId !== null && isStaleInteractionChainError(error):
      invalidateChain()                     // also clears pendingBackgroundInteractionId
      return createResponseImpl(options)    // re-enters background path, full resend, no chain
    if aggregatedText: attachPartialText(error, tail)
    throw error


executeBackgroundPath(client, commonParams, totalStepCount, stateful, endTag, signal):
  assert stateful  // background impossible in stateless mode (§5)
  submitParams = { ...commonParams, stream: false, store: true, background: true }
  logProgressStatus("Running Google Interactions in background mode; polling ...")

  submitted = await client.interactions.create(submitParams, {fetchOptions:{signal}})
  //          submit STILL sends the delta input + previous_interaction_id;
  //          captured id for the NEXT turn comes from the COMPLETED poll, not this submit.

  completed = await pollBackgroundInteraction(client, submitted, signal)

  finalizeChain(completed, totalStepCount, stateful)
  //   ↳ if completed.status === 'completed' && typeof completed.id === 'string':
  //        chainedInteractionId = completed.id   // NEXT turn chains onto polled completion
  //        sentStepCount        = totalStepCount
  //     else: invalidateChain()                  // next round full-resends

  return { response: completed }
  //   (createResponseImpl wraps it via withUpdated → attaches updatedMessages
  //    when this call compacted — compaction surfaces unchanged)


pollBackgroundInteraction(client, initial, signal):
  id = initial.id
  if typeof id !== 'string': warn; return initial   // can't poll; trust submit status

  pendingBackgroundInteractionId = id
  onAbort = () => void cancelBackgroundInteraction(client, id)   // fire-once
  signal.addEventListener('abort', onAbort, {once:true})
  if signal.aborted: onAbort()

  current = initial; pollCount = 0; start = now()
  try:
    while isBackgroundPending(current):            // pending set = {'in_progress'}
      pollCount++
      try: await delay(POLL_INTERVAL_MS, {signal}) // 5s, abort-aware
      catch err:
        if isUserAbort(err): log; throw err        // cancel already requested by onAbort
        throw err
      if now() - start > MAX_DURATION_MS:           // 3h
        throw Error("exceeded maximum polling duration ... cancel(id)")
      try:
        current = await client.interactions.get(id, {id, stream:false}, {fetchOptions:{signal}})
      catch err:
        sdkErrorTagger(err); if isUserAbort(err): throw err
        throw err                                   // transient → PocketFlow retry (§7.4)
  finally:
    signal.removeEventListener('abort', onAbort)
    pendingBackgroundInteractionId = null           // inFlight guard reset complement

  if current.status === 'completed': return current
  // terminal non-completed: failed | cancelled | incomplete | budget_exceeded
  err = Error('background interaction ended with status "<status>"'); sdkErrorTagger(err); throw err


TERMINAL set     = { completed (success), failed, cancelled, incomplete, budget_exceeded }
NON-TERMINAL set = { in_progress }   // requires_action treated as terminal in v0 (§7)
```

**Chaining ⊗ background composition (definitive):**

1. The **submit** sends the same `input` delta + `previous_interaction_id` the streaming/non-streaming paths send — chaining is entirely upstream of the background switch (built into `commonParams`).
2. The id captured for the **next** turn is `completed.id` from the **polled completion**, not `submitted.id`. `finalizeChain` only chains when `completed.status === 'completed'`; otherwise it invalidates so the next round full-resends.
3. **Compaction**: when this call compacted, `invalidateChain()` already ran (handler line 1385), so `shouldSendAll` is true and the background submit carries the compacted transcript with no `previous_interaction_id`; `withUpdated` attaches `updatedMessages = compactedMessages` to the returned result — unchanged from the streaming/non-streaming paths.

---

## 4. Abort / cancel

- **Registration:** `signal.addEventListener('abort', onAbort, { once: true })` in `pollBackgroundInteraction`, plus an immediate `if (signal.aborted) onAbort()` to cover a pre-aborted signal.
- **Cancel call:** `onAbort` invokes `cancelBackgroundInteraction`, which calls `client.interactions.cancel(interactionId)` (genai.d.ts line 4615: `cancel(id, params?: {api_version?}|null, options?): Promise<GoogleGenAIInteraction>`). Cancel is best-effort and swallows its own errors (the interaction may already be terminal). The fire-once listener does **not** `await` — the in-flight `delay()` / `get()` reject with `AbortError` (the `delay` package rejects with an `AbortError` on signal abort; genai `get()` rejects when its `fetchOptions.signal` fires), and those rejections propagate out of the loop.
- **Propagation:** the `delay`/`get` rejection is identified by `isUserAbort(err)` (`errorPatterns.ts:18`), logged, and rethrown — the user-abort surfaces to the caller exactly like the streaming/non-streaming paths.
- **`inFlight` guard reset:** the public `createResponse` override (handler lines 1297–1312) wraps `createResponseImpl` in `try { ... } finally { this.inFlight = false; }`. Since the entire poll loop runs inside `createResponseImpl`, the `finally` always resets `inFlight` whether the loop completes, throws on abort, throws on terminal status, or times out. The poll loop's own `finally` independently resets `pendingBackgroundInteractionId` and removes the abort listener. The two cleanups are complementary: `inFlight` guards concurrent `createResponse` calls; `pendingBackgroundInteractionId` is the cancel target / diagnostic. No leak on any exit path.

---

## 5. What stays the same

- **Streaming path** (handler lines 1424–1438) — unchanged. Unreachable while background is on (because `getStreamingConfig()` returns `false`), but byte-identical when background is off.
- **Non-streaming path** (handler lines 1440–1449) — unchanged. Runs when both background and streaming are off.
- **`consumeStream`, `finalizeSteps`, `applyDelta`, `extractResponse`, `processThinkingBlock`, `extractToolUse`** — untouched. Background reuses `extractResponse`/`processThinkingBlock` only indirectly via the returned `GoogleGenAIInteraction` (the completed interaction carries full `steps` + `usage`, genai.d.ts wrapper lines 5683–5685 / 6985, so the downstream extractors work without change).
- **Chaining (`finalizeChain` / `invalidateChain`) and compaction (`compactConversation`)** — unchanged except `invalidateChain` now also nulls the pending id (a safe additive reset).
- **Stale-chain catch** (handler lines 1450–1465) — unchanged; it transparently covers a stale-id error on the background submit.
- **Stateless mode (`store: false`) cannot use background.** Two layers enforce this: (1) `useBackgroundMode(stateful)` returns `false` when `stateful` is false, so the background branch is never selected; (2) `executeBackgroundPath` opens with `if (!stateful) throw` as a defense-in-depth assertion. In stateless mode the handler takes the existing streaming/non-streaming path with `store: false` and full resend, exactly as today.

---

## 6. Test plan

New file: `src/test-kernel/agent/modelHandlers/GoogleInteractionsBackground.vitest.ts`. Reuse `createConfig`/`silentLogger`/`userStep` from the chaining test pattern. Each handler is constructed with `handler.setAgentCategory(AgentCategory.Workflow)` (so `isWorkflowMode()` is true) and a config mock that returns `true` for both `texra.model.useGoogleInteractionsServerState` and `texra.model.useBackgroundResponses`. Use a **non-streaming capturing client** with `interactions.create` returning a plain `GoogleGenAIInteraction` (no SSE generator) plus stub `get`/`cancel`. Use `vi.useFakeTimers()` and advance timers to drive the poll loop deterministically (the `delay` package honors fake timers).

Fake client shape:

```typescript
function bgClient(opts: {
  submit: () => Interaction; // create() result
  getSequence: Interaction[]; // statuses returned by successive get()
  onCancel?: (id: string) => void;
}): unknown {
  let getIdx = 0;
  const calls = {
    create: [] as any[],
    get: [] as string[],
    cancel: [] as string[],
  };
  return {
    client: {
      interactions: {
        create: async (params: any) => {
          calls.create.push(params);
          return opts.submit();
        },
        get: async (id: string) => {
          calls.get.push(id);
          return opts.getSequence[
            Math.min(getIdx++, opts.getSequence.length - 1)
          ];
        },
        cancel: async (id: string) => {
          calls.cancel.push(id);
          opts.onCancel?.(id);
          return {};
        },
      },
      models: {},
    },
    calls,
  };
}
```

| #       | Test                                                    | Setup                                                                                                                                                            | Assertions                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1**  | Background submit sets `background:true` + `store:true` | gate on; submit returns `{id:'int_1', status:'in_progress'}`, `get` returns `{id:'int_1', status:'completed', steps:[modelOutput('ok')]}`                        | `calls.create[0].background === true`; `calls.create[0].store === true`; `calls.create[0].stream === false`                                                                                                    |
| **B2**  | Polls `get()` until `completed`                         | submit `in_progress`; `getSequence = [in_progress, in_progress, completed]`                                                                                      | run with fake timers, advance by `POLL_INTERVAL_MS` ×3; `calls.get` length ≥ 3; all entries `=== 'int_1'`; resolved result `.response.status === 'completed'`                                                  |
| **B3**  | Captures chain id from the **polled completion**        | submit `{id:'int_submit', status:'in_progress'}`; `get` → `{id:'int_done', status:'completed', steps:[...]}`. Then a 2nd `createResponse` with one appended step | 2nd `create` call's `previous_interaction_id === 'int_done'` (NOT `'int_submit'`); 2nd call's `input` length === appended delta count                                                                          |
| **B4**  | Cancel on abort calls `interactions.cancel`             | submit `in_progress`; `get` stays `in_progress`; pass an `AbortController`; abort after first poll tick                                                          | `await expect(promise).rejects` (AbortError); `calls.cancel` contains `'int_1'`; handler `pendingBackgroundInteractionId` is null afterward (assert via a follow-up call succeeding, i.e. no leak)             |
| **B5**  | Background + stateless is rejected/skipped              | mock `useGoogleInteractionsServerState → false`, `useBackgroundResponses → true`                                                                                 | `calls.create[0].background` is `undefined`/falsy AND `calls.create[0].store === false` (took the non-background path); no `get` calls. (Confirms the gate, not the assert — the assert is unreachable here.)  |
| **B6**  | Toggle off ⇒ no background                              | `useBackgroundResponses → false`, stateful true                                                                                                                  | `calls.create[0].background` falsy; non-streaming/streaming path taken; zero `get` calls                                                                                                                       |
| **B7**  | Terminal non-completed throws and does not chain        | submit `in_progress`; `get` → `{status:'failed'}`                                                                                                                | `await expect(...).rejects.toThrow(/status "failed"/)`; a subsequent `createResponse` does a full resend (`previous_interaction_id` undefined) — `finalizeChain` never ran, `chainedInteractionId` stayed null |
| **B8**  | `requires_action` is terminal in v0                     | `get` → `{status:'requires_action'}`                                                                                                                             | rejects (treated as terminal non-completed); no infinite poll                                                                                                                                                  |
| **B9**  | Timeout guard                                           | submit `in_progress`; `get` always `in_progress`; advance fake clock past `BACKGROUND_MAX_DURATION_MS`                                                           | rejects with `/maximum polling duration/`; `pendingBackgroundInteractionId` reset                                                                                                                              |
| **B10** | Compaction composes with background                     | force compaction (mock `shouldCompactByInputTokens` / large `lastKnownInputTokens`), background on                                                               | returned result has `updatedMessages` set; background submit has no `previous_interaction_id` (chain invalidated by compaction); submit `input` = compacted transcript                                         |

**Real-key SMOKE-TEST items (cannot be unit-tested offline; flag in test file header comments):**

- **S-BG1**: Confirm the **initial status** of a `background:true` create (expected `in_progress`; if it's a `(string & {})` value not in the union, extend `BACKGROUND_PENDING_STATUSES`). (report 2 §2/§4.)
- **S-BG2**: Confirm `background:true` is accepted with `store:true` and rejected (or silently ignored) with `store:false`. (report 2 smoke-test #2.)
- **S-BG3**: Confirm `interactions.get(id)` on a completed background interaction returns full `steps` + `usage` (report 2 §5 says yes from the `.d.ts`; verify on the wire).
- **S-BG4**: Confirm `interactions.cancel(id)` on an `in_progress` interaction transitions it to `cancelled` and that a subsequent `get` reflects that (report 2 smoke-test #4).
- **S-BG5**: Observe real poll cadence / latency to tune `BACKGROUND_POLL_INTERVAL_MS` (start at 5s; §7.1).

---

## 7. Risks / gotchas

**7.1 Poll cadence / cost.** Each `get(id)` is a billable API round-trip. OpenAI uses 15s (`BACKGROUND_POLL_INTERVAL_MS = 15000`, line 266). Google Interactions latency is unconfirmed offline; start at **5s** (workflow turns are typically shorter than OpenAI deep-research jobs) and tune via S-BG5. Consider exponential backoff later, but v0 ships a fixed interval to match the OpenAI structure and keep the loop auditable. There is **no ETA/retry-after field** on the `Interaction` type (report 2 §6: only `created`/`updated` ISO timestamps), so cadence cannot be server-driven.

**7.2 Partial / never-completing interactions.** The `BACKGROUND_MAX_DURATION_MS = 3h` guard throws rather than spinning forever. The error message tells the user to `cancel(id)`. A stuck `in_progress` consumes one `get` every interval until the cap — acceptable but worth the cap.

**7.3 Background incompatible with `store:false`.** Enforced twice (gate + assert, §5). The assert is the safety net if a future refactor lets the gate drift.

**7.4 No resume path in v0 (deliberate simplification vs OpenAI).** OpenAI keeps `pendingBackgroundResponseId` across retries and resumes via `tryResumeBackgroundResponse` (lines 366–464). The Google handler **does not** implement resume in v0: on a transient poll error it rethrows, PocketFlow retries `createResponse`, the chain bookkeeping resubmits a fresh background interaction, and the orphaned one ages out / can be cancelled. This is simpler and safe (the new submit chains onto the last _completed_ id, never the orphan). `pendingBackgroundInteractionId` exists only as the cancel target + diagnostic, cleared in the poll loop's `finally`. If real-key runs show frequent mid-poll disconnects on long jobs, port the resume machinery in a follow-up.

**7.5 Progress UX.** A single `logProgressStatus` at submit announces background mode; per-poll status changes go to `this.logger.debug` (not user-facing) to avoid spamming the progress board every interval. Unlike streaming, **there is no incremental output** during a background job — the user sees one "polling" message then the final result. This is inherent to background mode and matches OpenAI's behavior (line 1668–1672). The TUI/progress view will show the run as "in progress" with no token stream until completion.

**7.6 `.d.ts` could not confirm:**

- The **initial status** after `background:true` create (S-BG1) — drives `BACKGROUND_PENDING_STATUSES`.
- Whether `stream:true` + `background:true` is a valid combination (report 2 §2: type system allows it, behavior unspecified). The handler never sends both: background always sets `stream:false`.
- Semantics of `incomplete` and `budget_exceeded` as background terminal states (report 2 §4 flags `incomplete` as unclear) — all non-`completed` terminal statuses are treated uniformly as a thrown error, which is correct regardless of the exact reason.
- `interactions.cancel` return value is `Promise<GoogleGenAIInteraction>` (line 4615) but the handler ignores it (best-effort).

**7.7 `inFlight` holds for hours.** Because the poll loop runs inside the `inFlight`-guarded `createResponseImpl`, a 3-hour background job blocks any concurrent `createResponse` on the same instance for that duration. This is the intended single-turn contract (handler lines 1289–1292; class doc on OpenAI lines 184–188) and matches OpenAI. Each run gets a fresh handler instance, so cross-run concurrency is unaffected.

---

### Verified

- `src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts` (full, 1758 lines): `createResponseImpl` dispatch (lines 1335, 1389–1449), `commonParams`/`requestOptions` (1410–1421), `finalizeChain`/`invalidateChain` (279–310), `serverStateEnabled` (271–276), `inFlight` guard (1297–1313), stale-chain catch (1450–1465), `consumeStream` (1527–1615), SDK type aliases (99–111).
- `src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts` (lines 1–2089): background gate (222–264), poll loop `waitForBackgroundCompletion` (1891–2068), `executeNonStreamingPath` (1647–1698), constants (266–270), `inFlight`/`pendingBackgroundResponseId` (281–298), abort handling (1939–2017).
- `src/agent/modelHandlers/ModelHandler.ts`: `backgroundModeSupported=false` (131), `isWorkflowMode` (201–203), `isBackgroundModeActive` base (236–238), `getStreamingConfig` base (518–524).
- `src/shared/schemas/coreSettings.ts`: `useBackgroundResponses` already present at all 3 sites (84, 336–338, 575) — no edit.
- `src/common/errors/sdkError/errorPatterns.ts:18` — `isUserAbort` (re-exported via `@common/errors/sdkErrorUtils`).
- `src/utils/core/index.ts:27` + `src/utils/core/async.ts:5` — `delay` re-export (from the `delay` npm package, AbortSignal-aware per `node_modules/delay/index.d.ts`).
- `src/test-kernel/agent/modelHandlers/GoogleInteractionsChaining.vitest.ts` — capturing-client + config-mock test pattern reused for the background suite.
- SDK signatures taken verbatim from research report 2 (genai.d.ts): `get` (4609–4611), `cancel` (4615–4617), `create` non-streaming (4602), `CreateModelInteraction.background` (2389), `InteractionStatus` union (7620), `GoogleGenAIInteraction` wrapper with non-optional `steps` (5683–5685). `@google/genai` is a pnpm workspace symlink not present in this worktree's local `node_modules`, so these were not re-opened here; treat report 2's line citations as the source of truth and re-verify against the resolved package during implementation.
