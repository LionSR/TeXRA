# D. The model call path: design red-flag audit (read-only)

Scope: `packages/harness/src/agent/runtime/run/*`, `ModelInvoker.ts`,
`ModelRetryGate.ts`, `helperModel*.ts`, `requestPolicy.ts`,
`modelAccess/*`, and in `packages/llm/src`: `errors.ts`, `turn.ts` (`Model`),
`api/configuration.ts`, `api/responsesConfiguration.ts`, `api/background.ts`,
`oauth/sharedAttempt.ts`, `oauth/SubscriptionOAuthCoordinator.ts`,
`oauth/authProgram.ts`, `api/uploadCache.ts`, `api/anthropicThreads.ts`, and
`platform/defaults/longRunningModelTransport.ts`. All paths below are under
`/home/user/TeXRA/`. Consumer counts are over `packages/*/src` unless marked.

Comment-line share (`grep -cE '^\s*(/\*|\*|//)'` / total):

| file                                       | share |
| ------------------------------------------ | ----- |
| `packages/llm/src/oauth/sharedAttempt.ts`  | 41%   |
| `agent/runtime/helperModel.ts`             | 28%   |
| `packages/llm/src/errors.ts`               | 27%   |
| `agent/runtime/modelAccess/failureInfo.ts` | 27%   |
| `packages/llm/src/api/uploadCache.ts`      | 26%   |
| `agent/runtime/modelAccess/ModelAccess.ts` | 24%   |
| `shared/session/inFlight.ts`               | 23%   |
| `agent/runtime/run/requestContext.ts`      | 22%   |
| `agent/runtime/run/invocation.ts`          | 21%   |
| `agent/runtime/ModelRetryGate.ts`          | 16%   |
| `agent/runtime/ModelInvoker.ts`            | 12%   |
| `packages/llm/src/api/background.ts`       | 9%    |

The two highest (`sharedAttempt.ts`, `helperModel.ts`) are the two files whose
comments explain a hand-off protocol (finding 6) and a set of nulls meaning
"no run" (finding 7).

---

## 1. One retry loop, three drivers, two stacked driver interfaces

**Red flags:** shallow module; special and general code mixed; state machine
in nullable fields; pass-through with re-encoding at each layer; in-memory
loop state in a loop documented as stateless.

**Evidence.**

- `InvocationDriver` has eight members (`read`, `binding`, `rebind`,
  `attempt`, `failed`, `asker`, `retries`, `logger`;
  `packages/harness/src/agent/runtime/run/invocation.ts:83-114`) plus
  `Asker` with three more (`await`, `reask`, `requestId`; `:71-80`), plus
  three helper types a driver must speak (`AttemptFailure` `:57-60`,
  `InvocationView` `:64-67`, `InvocationEnd` `:117-124`). `runInvocation`
  has two callers: `ModelInvoker.invoke` (`ModelInvoker.ts:632`) and
  `callModel` (`run/modelCall.ts:123`). Consumer count of
  `InvocationDriver`: 9 mentions, all in `invocation.ts`.
- `callModel` is a second driver interface on top: `ModelCall` has nine
  members (`modelCall.ts:44-81`) of which three are nullable markers for
  "not a run" (`logger: ... | null` `:64`, `record: ... | null` `:67-80`,
  `retries?` `:62`) and `purpose: 'compaction' | 'helper'` (`:46`) is read
  only in three error messages (`:119,135,190,195`). `callModel` has two
  callers: `ModelInvoker.call` (`ModelInvoker.ts:712`) and `helperCall`
  (`helperModel.ts:74`).
- The second driver implements the first by faking the rows: an in-memory
  `Ref<Invocation>` folded with `invocationAfter` (`modelCall.ts:107-122`),
  `requests: {}` (`:126`), `asker: null` (`:183`); a helper's attempt is
  folded as `purpose: 'summary'` with a made-up address
  `sha256(prepared)` (`:141-147`) although it writes no row. The loop's
  `consult` dies if the null asker is ever reached
  (`invocation.ts:234-238`): the general loop carries `await`/`reask`
  machinery that exactly one of its two drivers can use.
- The rebind decision is re-encoded at every layer: `RetryCredentials |
  'renewed'` (`invocation.ts:90-93`) → `reacquire(failed, renew: boolean)`
  (`modelCall.ts:52-55`, `:129-130` converts) → `acquire(rejected?: string)`
  (`helperModel.ts:69-80` converts again) and, on the run side, back to
  `'renewed' | 'configured'` (`ModelInvoker.ts:719`).
- The header says "the loop keeps no count and no permit of its own"
  (`invocation.ts:4-6`), yet it keeps two: `credentialRenewal`'s `spent`
  (`:147`) and `again` (`:354`). A resume after a renewal renews again; the
  rule "every fact the loop branches on is a row field" (harness
  `AGENTS.md` "Write points") is broken by exactly these two.
- The fold already ignores a summary's attempts: `isSummaryAttempt`
  (`shared/session/turnRowHandlers.ts:282-283`) and the comment "the loop
  continues from none of them (its `context.edit` carries its usage)"
  (`:291-293`). A failed summary attempt records no usage
  (`ModelInvoker.ts:739-751` writes `error, next` only), so the rows give
  no billing fact the `context.edit` lacks.

**The design decision behind it.** "Which model calls are driven by rows?"
Only a turn is: a resume continues it, a person answers it, and its budget
is counted from its rows. A compaction summary and a helper call are made
anew after a crash (`modelCall.ts:86-87`) and nobody is asked. The code
answers "all of them" and then subtracts the row-driven parts with nulls.

**The better design.** Two loops because there are two kinds of call:

- A turn: `runInvocation` inlined into `ModelInvoker.invoke` (its one
  caller). `InvocationDriver`, `Asker`, `InvocationView`, `AttemptFailure`,
  `rebound`, `tryAttempt`, `consult`, `afterFailure`, `credentialRenewal`
  become file-local steps of one `Effect.fn` over `cell`, `run.model` and
  the gate; nothing is generic over `A, E, R`. The renewal (see finding 5)
  leaves the loop entirely.
- A call off the rows (summary, helper): `gate.withRoutes(bound.routes)(
  completedTurn(bound.model.streamTurn(prepared)))` under
  `Effect.retry({ while: (e) => e instanceof ModelError && e.retryable,
  times: retries, schedule: Schedule.spaced(RETRY_BACKOFF_MS) })`
  (`node_modules/effect/dist/Effect.d.ts:7132-7144` documents `while`,
  `times`, `schedule`), then `priceTurnUsage` + `reportUsage`. About 40
  lines, no driver, no Ref fold.

Deleted: `InvocationDriver` (9), `Asker` (2), `ModelCall` and its `record`,
`purpose`, `retries?`, `logger | null` (file `modelCall.ts`, 198 lines),
`reacquire` (5 refs, 4 files), `InvocationPurpose` and the `purpose` field
on `attempt`/`failed` rows (`shared/schemas/runHistoryEvent.ts:57-59,
150, 166`; 6 refs) together with `isSummaryAttempt` and the `'any'`
requirement it needs (`turnRowHandlers.ts:282-298`), and `invocationAfter`'s
only non-fold caller. `ModelInvoker.call` becomes a plain function the
compaction calls with the bound model (one caller, `compaction.ts:149`).

**What we give up.** A summary's `attempt`/`failed` rows. Harness `AGENTS.md`
line 69 states "A compaction summary records its attempts (`purpose:
'summary'`)"; the rationale given is that they record its billed calls, but
the fold ignores them and the only usage they could carry is already on the
`context.edit` row (`compaction.ts:228`), so the rule records a design that
no reader uses. If the owner wants the audit row, the compaction can append
one `attempt` row before its call (one writer, no `purpose` field). Risk:
low; `model.message` loses a field (version bump).

**Change amplification.** "A second call off the rows" (a run title, a
follow-up suggestion): today, implement the nine-member `ModelCall`
(`modelCall.ts:44-81`), choose a `purpose` literal, null three fields, and
route it through `runInvocation`'s driver (two files touched plus the
caller); after, one `Effect.retry` at the caller.

---

## 2. llm's verdict is re-encoded into a display classification, and the loop branches on the re-encoding

**Red flags:** two representations of one fact; re-classification after O8;
information leakage (the meaning of `'personal'` is known by five modules);
wording stored as data.

**Evidence.**

- The `failed` row stores `RetryErrorInfo` "in the runtime's own failure
  vocabulary (deliberately not the llm package's `ModelError`)"
  (`shared/schemas/runHistoryEvent.ts:162-166`). That vocabulary is
  `ProviderErrorClassification` (`shared/schemas/errors.ts:15-45`), produced
  by `classificationOf` (`common/errors/sdkError/providerErrorFormat.ts:62-79`)
  from `error.kind === 'context-overflow'`, `quota.plan === null`,
  `quota.plan`, `RouteUnavailable.session`, `RouteUnavailable.reason`. That
  is a classification of llm's classification.
- The loop reads the re-encoding back: `compaction.afterOverflow` branches on
  `failed.error.classification?.kind !== 'context-window'`
  (`run/compaction.ts:417-421`), i.e. the overflow retry depends on the
  display vocabulary, not on `ModelError.kind`.
  `agentErrorPresentation` reads `classification?.kind === 'missing-api-key'`
  (`common/errors/agentErrorClassification.ts:50-53`);
  `requestPolicy.answerFor` derives `isCredentialFailure` from
  `credentialSwitch != null` (`requestPolicy.ts:157`), a third spelling of
  "a quota ran out".
- The stored `message` is already worded text (`usedUpPlanMessage`,
  `httpErrorMessage`, `routeMessage`: `providerErrorFormat.ts:91-144`), so a
  wording change is a stored-format change, and the fold-time words cannot
  be re-worded by a host (`failureIn`'s `cause instanceof AgentError ?
  cause.failure` `:186-191` reads them back as the truth).
- Places that decide "retryable / which credential / which plan ran out"
  after O8, counted: llm's verdict (`packages/llm/src/api/verdict.ts`,
  `errors.ts:130-151`) — 1; `moveAfter`'s `{unchain, automatic, offered}`
  with `offered: retryable || quota !== undefined` (`invocation.ts:265-297`)
  — 2; `credentialRenewal`'s `kind === 'authentication' &&
  subscriptionToken` (`:152-157`) — 3; `routePolicies`' two
  `classifyFailure` closures over `scope` (`modelAccess/failureInfo.ts:45-68`)
  — 4; the gate's `settle` with its four outcomes for one exit
  (`ModelRetryGate.ts:129-172`) — 5; `classificationOf` — 6;
  `credentialSwitch` (`modelAccess/routeDecision.ts:184-219`) — 7;
  `answerFor` — 8; the fold's `declinedBy` (`credentials === 'personal' &&
  offer.kind === 'decline-route'`, `shared/session/runState.ts:243-257`)
  — 9; `rebind`'s `selection === 'personal' ? undefined : failed.config`
  (`ModelInvoker.ts:533-535`) — 10; the app's `surfaceDecision`
  (`packages/texra/src/shared/session/surfaceDecision.ts:175-192`) — 11.
  Items 2–5 are the harness acting on the verdict (acceptable if each is
  the only reader of its field); 6, 8, 9, 10, 11 are re-encodings.
- `'personal'` leaks: its meaning ("decline the route the offer named, bind
  on the catalog config, declare the route declined") is assembled from
  `request.decided.credentials` (`shared/schemas/request.ts:70-77`), the
  `request.opened`'s `credentialSwitch` (`prompts.ts:155`), the fold
  (`declinedBy`), and `rebind` dropping the overlay because it knows
  `BoundModel.config` is route-overlaid (`ModelInvoker.ts:531-535`). The
  invoker also answers its own question through the person's channel: an
  automatic fallback opens a `request.opened` and writes `PERSONAL_RETRY`
  as its `request.decided` in the same batch (`ModelInvoker.ts:99-103,
  620-628`).

**The design decision behind it.** "What does the `failed` row record: the
verdict or the words?" It records the words plus a lossy projection of the
verdict, so every later decision has to be made from the projection.

**The better design.** The row records the verdict. `RetryErrorInfo` =
llm's `ModelErrorFields` minus `cause` (kind, retryable, scope, quota,
status, requestId, partialText, retryAfterMs, `errors.ts:66-120`) tagged
`'model'`, or `RouteUnavailable`'s fields (`reason`, `session`) tagged
`'route'`, plus `provider`. `providerErrorOf` becomes a pure projection at
every reader (transcript row, retry panel, `run.end` presentation);
`ProviderErrorClassification` is deleted; `compaction.afterOverflow` reads
`kind === 'context-overflow'`; `answerFor` reads `quota !== undefined`.
The credential move: the `failed` row's `next` carries it,
`{ kind: 'ask', requestId, offer: CredentialSwitch | null }`, so the fold's
`declinedBy` reads the failed row, not the request's payload; an automatic
fallback is `next: { kind: 'retry', declines: route }` and opens no request.
`BindRequest.config` goes (the bind always starts from the catalog entry
and the route overlays it, as `routeConfig` already does at
`packages/llm/src/api/configuration.ts:141`), which deletes the special case in
`rebind` and the `config: selected.config` argument in `modelSwitch.ts:60`.

Deleted: `ProviderErrorClassificationSchema` and `classificationOf` (the
word `classification` appears in 31 files; about 12 of them are this
schema: `transcriptRow.ts`, `projectTranscriptRow.ts`, `progressEvents.ts`,
`progressView/data.ts`, `runRecords.ts`, `prompts.ts`, `errors.ts`,
`HostInteractions.ts`, `agentErrorClassification.ts`, `compaction.ts`,
`providerErrorFormat.ts`, `texra/ui/copy/modelAccess.ts`, the CLI's
`executeCli.ts`/`chatSessionController.ts`/`dispatch.ts`); `PERSONAL_RETRY`;
`declinedBy`'s request read; `BindRequest.config` (3 writers).

**What we give up.** Another format change on `model.message`,
`request.opened` and `run.end` (the note's area D already bumped them once
on 2026-11-04); host copy moves from stored text to a projection, which is
also what makes it localizable. Risk: medium, many host readers.

**Change amplification.** "llm learns a new verdict kind" (say
`content-filtered`, non-retryable, offered): today `errors.ts`,
`verdict.ts`, `classificationOf`, `ProviderErrorClassificationSchema`, the
hosts' `switch` on classification, and `moveAfter` — 6 files; after,
`errors.ts` and `verdict.ts` plus the one projection — 3.

---

## 3. "This turn runs in the background" has seven representations and four checks

**Red flags:** two (seven) representations of one fact; information leakage
across llm and harness; a provider-specific option for a special case;
dedup at write time; two writers of one mutable record.

**Evidence.** The fact "background delivery is possible / wanted" lives in:

1. `BindSpec.options.background` (`packages/llm/src/node.ts:69-70`);
2. `ModelConfiguration.background: 'supported' | 'unsupported'`
   (`turn.ts:153,159`; set in `api/configuration.ts:105`,
   `responsesConfiguration.ts:42,87,109-112`);
3. `backgroundCapable(configuration)` (`protocol.ts:104-111`, where Google
   also needs `defaults.store`);
4. `Model.background?` presence (`turn.ts:480`);
5. `Binding.background: boolean` = `model.background !== undefined`
   (`node.ts:221`);
6. `BoundModel.delivery: Effect<'foreground' | 'background'>`
   (`modelAccess/binding.ts:204-208`), computed by `backgroundOn`
   (`:51-60`) once at bind (`:179`, into representation 1) and again per
   turn over `readGoogleBackground` (`:206`;
   `model/modelSettings.ts:93-98`);
7. `TurnRequest.mode` / `ResolvedTurn.mode` (`turn.ts:102, 248-258`).

Checks of the same capability: `turnInput.ts:53` (`mode === 'background'
&& background === undefined`), `googleInteractions.ts:576-581` (store),
`submitAndObserve` (`run/backgroundTurn.ts:122-127`, unreachable after
`prepareTurn` resolved a background turn on the same binding),
`observeAccepted` (`ModelInvoker.ts:468-475`). `attemptOnce` then branches
again on `mode` for the output budget (`:401-403`) and the stream/submit
split (`:446-457`).

The Google toggle `model.useGoogleBackgroundResponses` is read live per turn
while a Responses route "goes out so whenever its route can"
(`modelSettings.ts:91-92`): one provider gets a knob, the other a rule.

Two writers for the provider's identity: `eventSink` appends `identified`
after reading `cell.current` to dedupe (`ModelInvoker.ts:226-248`,
"a background operation may report it twice") because llm's `observe`
re-emits the identity it was handed (`api/background.ts:184-190` for the
polled case; the streamed case replays it too). `submitAndObserve` appends
`identified` itself (`backgroundTurn.ts:138-147`). Two writers of the
completed turn: `eventSink` (`ModelInvoker.ts:265-267`) and
`submitAndObserve` (`backgroundTurn.ts:130-132`) on the shared mutable
`AttemptOutcome`.

**The design decision behind it.** "Who decides the delivery mode, and
when?" Today: the catalog says capable, the bind says wanted, the toggle
says wanted again per turn, the request says which, and the model checks
all of it once more.

**The better design.** One decision at bind: `BoundModel.delivery` is a
value, `'foreground' | 'background'`, computed once from `textOnly`, the
configuration's capability and one toggle (either one toggle for every
capable route or none). `Model.background` is present iff the configuration
says `'supported'`; `Binding.background`, `BindSpec.options.background`,
`backgroundOn` and the per-turn `readGoogleBackground` go. The second and
third capability checks (`submitAndObserve`, `observeAccepted`) become
`Effect.die` on a state the types exclude, or go. `observe` emits no
`identified` (the caller gave it the operation), and `submit`'s completed
result is fed to the same sink as a `completed` event
(`Stream.make({ kind: 'completed', result })`), so `identified` and the
completed turn each have one writer and `eventSink`'s dedupe read is
deleted.

Deleted: `backgroundOn` (3), `readGoogleBackground` (4 refs, 2 files),
`Binding.background` (`node.ts:90, 221`; read at `binding.ts:204`),
`BindSpec.options.background`, the `identified` dedupe in `eventSink`, the
capability checks at `backgroundTurn.ts:122-127` and
`ModelInvoker.ts:468-475`.

**What we give up.** A toggle flipped mid-run applies at the next bind (a
switch, a rebind) instead of the next turn. Risk: low.

**Change amplification.** "Anthropic gains background delivery (batches)":
today `RemoteOperationSchema`'s protocol literal
(`packages/llm/src/errors.ts:14`), the background union of
`ResolvedTurnSchema` (`turn.ts:248-258`), the Anthropic configuration
variant which has no `background` field (`turn.ts:187-194`),
`backgroundCapable`'s switch (`protocol.ts:104-111`), the Anthropic model,
`backgroundOn`'s protocol test (`binding.ts:59`), the Google-named toggle,
`admittedTurn`'s Responses-only transport patch
(`run/requestContext.ts:288-290`), `StoredOperationSchema` — 9 files;
after: the schema literal, the union, the model, the configuration field — 4.

---

## 4. `ModelRetryGate`: a hand-rolled waiter queue with version counters, and options with one caller

**Red flags:** reinvented Effect primitives (a `Latch` and a `Semaphore`
written by hand with `Deferred.makeUnsafe`, two `uninterruptibleMask`s and
a generation counter); option for a special case; a callback parameter with
one shape; a backoff applied twice.

**Evidence.**

- `ModelRetryGate.ts` (432 lines) keeps per route `version` (`:43, 297,
  337`), a `waiters` array (`:48, 249, 341`), a probe-fiber slot "taken
  before the fiber exists" (`:35-40`), a `Waiter.granted` written before the
  Deferred completes so an interrupt "between the grant and the waiter
  resuming" still returns the probe (`:27-32`), `uninterruptibleMask` at
  `:117` and `:235`, `Deferred.makeUnsafe` at `:246`, and a revalidation
  loop that re-acquires every permit when "a later wait can make an earlier
  permit stale" (`:174-202`). Each is evidence the fiber model is being
  fought.
- `withRoutes(routes, { baseBackoffMs, onWait })` has one caller
  (`run/invocation.ts:200-207`); `baseBackoffMs` is the constant
  `RETRY_BACKOFF_MS`, `onWait` is always `logger.debug(...)`. The same
  constant is also slept in `pauseBefore` (`invocation.ts:244-261`) before
  the gate's own jittered wait (`ModelRetryGate.ts:300-310`): one failure,
  two backoffs.
- `RoutePolicy.classifyFailure` / `isReachableFailure` are two closures per
  route built in `routePolicies` (`failureInfo.ts:45-68`) over the one
  field `ModelError.scope`; because classification is a callback, `settle`
  has to handle an "unclassified" failure with two different outcomes
  (`:155-168`).
- What the gate owns versus the rows: the rows own the per-invocation
  budget (`spentRetries`, `inFlight.ts:202-203`) and the move; the gate owns
  per-route health (`failures`, `retryAt`, phase). These are different
  facts and the split is right; nothing in the gate restates a row.

**The design decision behind it.** "How do N fibers on one route wait for
one of them to prove it healthy?" That is a closed `Latch` plus a
one-permit `Semaphore` for the probe. The code builds both from scratch.

**The better design** (the concept stays, see "Already settled"): per route
`{ latch: Latch (effect/Latch.d.ts:189-351), probe: Semaphore(1),
failures, retryAt }`. A call: `Latch.whenOpen(latch)(send)` when healthy;
when cooling, `Effect.sleep(retryAt - now)` then
`probe.withPermits(1)(send)`; a success opens the latch and zeroes
`failures`; a failure with `scope` set closes the latch, bumps `failures`,
sets `retryAt = jittered(failures) max retryAfterMs`; an interrupt releases
the permit by itself. The narrower model route is a second latch awaited
first. `RoutePolicy` becomes data `{ key, scope }` and the gate reads
`error.scope` and `error.retryAfterMs` directly. Deleted: `RouteState.version`,
`waiters`, `Waiter`, `ScheduledProbe`, `acquire`, `acquireAll`,
`isCurrentPermit`, `leave`, `abandon`, `abandonAll`, `abandonRoute`,
`cancelProbe`, `scheduleProbe`, `close` (about 250 lines), `RouteOptions`,
`RoutePolicy.classifyFailure`/`isReachableFailure`, and the sleep in
`pauseBefore` (the gate owns the wait). `packages/harness/test/agent/runtime/ModelRetryGate.vitest.ts`
(2 cases) is rewritten against the same observable behaviour.

**What we give up.** The exact "oldest waiter probes" guarantee (a
semaphore's FIFO gives it anyway) and the "unclassified failure keeps the
cohort closed" rule (`:158-164`), which with `scope` as data becomes "no
scope: the route is reachable". Risk: medium, it is process-wide; a wrong
latch state stalls every run on a credential, so the two existing cases plus
one for interruption while waiting must pass before the old file goes.

**Change amplification.** "Cool a third scope (an endpoint across models of
one provider)": today `routePolicies` adds a closure pair and `settle`'s
branch table grows; after, one more `{ key, scope }` row.

---

## 5. The binding's lifetime is a hand-rolled `ScopedRef`, and a bearer token rides on the binding so the loop can renew it

**Red flags:** reinvented Effect primitive; temporal decomposition (renewal
is split across four files by when it happens); information leakage (a
secret leaves model access so another module can hand it back); a
compare-and-swap by object identity; a renewal that spends a retry.

**Evidence.**

- `AgentRun.swapModel` (`run/AgentRun.ts:283-314`) forks a scope, runs
  `next`, closes the fork on failure or no-op, swaps `let bindingScope`,
  closes the retired scope, inside `SynchronizedRef.updateAndGetEffect`.
  That is `ScopedRef.set` (`node_modules/effect/dist/ScopedRef.d.ts:118-158`:
  "replaces it with another acquired value while ensuring the previous ...
  released"), which `helperCall` already uses for the same job
  (`helperModel.ts:73-88`). `swapModel` has 6 refs in 3 files.
- `rebind` detects a concurrent switch by `current !== failed`
  (`ModelInvoker.ts:524-526`, "A switch may have landed while the panel
  waited; never undo it"): the run's model is a row fact (`run.config`,
  `AgentRun.ts:130-137`), yet the check is on object identity.
- `BoundModel.subscriptionToken` (`modelAccess/ModelAccess.ts:75-76`) exposes
  the bearer, against `credentials.ts:4` ("The secret reaches the binding's
  transport and never a row"), only so `rebind('renewed', failed)` can send
  it back as `BindRequest.rejected` (`ModelAccess.ts:91-93`,
  `HelperRequest.rejected` `:101`), through `bindOver` → `bindRoute` →
  `routeCredential(..., rejected)` (`credentials.ts:173-188`) →
  `subscriptionCredential` (`:97-132`) → `coordinator.refreshRejected(token)`
  (`SubscriptionOAuthCoordinator.ts:172-176`). The decision to renew is in
  `invocation.ts:144-166`; the rebind in `ModelInvoker.ts:519-549`; the
  threading in `ModelAccess.ts`/`credentials.ts`; the refresh in the
  coordinator: one operation, four files, ordered by time.
- A renewal is recorded as `next: { kind: 'retry' }` (`invocation.ts:333-336`)
  and so spends one of the automatic retries (`spentRetries` counts every
  failure but `unchain`, `inFlight.ts:202-203`); its once-per-invocation
  guard is the in-memory `spent` (`invocation.ts:147`), so a resumed run
  can renew again.

**The design decision behind it.** "Whose job is a fresh bearer?" The
coordinator already single-flights and stores refreshes; the harness still
decides when to ask it, and routes the token through five signatures to do
so.

**The better design.**

- `AgentRun.model` is a `ScopedRef<BoundModel>`; `swapModel` and
  `bindingScope` go. A model switch is `ScopedRef.set(model, access.bind(...))`
  inside the loop's model boundary (`loop/modelSwitch.ts:56-75` already
  appends the `run.config` row there); `rebind` compares `state.modelId`
  (a row) to decide whether a switch landed, not object identity.
- The bearer is the credential's own concern: `ModelCredential` becomes
  `{ kind: 'chatgpt', accessToken: Effect<string, ModelError> }`
  (`node.ts:40-41`), served by the coordinator (`getFreshSession` already
  refreshes before expiry). The Responses client takes the token per
  request (today `openaiClient` builds one `new OpenAI({ apiKey })` per
  binding, `api/openaiResponsesRequest.ts:240-245`; a client per request,
  or a `fetch` that injects the header, costs nothing). On a 401 llm asks
  the coordinator to refresh the token it was last given and resends once,
  unbilled, inside the same attempt. The harness never sees a renewal.
  Deleted: `BoundModel.subscriptionToken` (6 refs, 5 files),
  `BindRequest.rejected`, `HelperRequest.rejected`, `credentialRenewal`
  and `spent`, the `'renewed'` literal in `rebind`, `reacquire`'s `renew`,
  `helperCall`'s `acquire(rejected)`, `routeCredential`'s fourth parameter,
  `subscriptionCredential`'s `refresh` branch.

**What we give up.** The renewal stops appearing as a `failed` row (today
it is one, labelled a retry). Harness `AGENTS.md` "Provider SDK retries stay
disabled" needs one clause: a credential refresh is not a billed resend.
Risk: low for `ScopedRef`; medium for the credential getter (the OpenAI
SDK's per-request token path must be verified against the pinned version;
the fallback is a client per request).

**Change amplification.** "A third subscription (an Anthropic plan)":
today `credentials.ts` (the two ternaries at `:109-126`), `binding.ts`
(`:155, 164-166, 187-189`), `ModelAccess.ts` (`subscriptionToken`),
`invocation.ts` (`credentialRenewal`), `PLAN_ROUTES`,
`SubscriptionSessionRouteSchema`, `node.ts` `ModelCredential`,
`responseAuthentication`, a coordinator — 9 files; after: `PLAN_ROUTES`, the
coordinator, `node.ts` — 3.

---

## 6. The OAuth coordinator builds three primitives to let a login supersede a refresh

**Red flags:** reinvented Effect primitives (single-flight, serialized
writes with an idle barrier, a generation counter); comments substituting
for design (`sharedAttempt.ts` is 41% comment, all of it explaining why the
work is detached).

**Evidence.**

- `SharedAttempt` (`packages/llm/src/oauth/sharedAttempt.ts:23-63`):
  `uninterruptibleMask`, `forkDetach`, `Deferred.makeUnsafe`,
  `Deferred.doneUnsafe`, a `slot`, `clear()`, `inFlight`. Its doc says the
  detached fiber "must carry its own deadline: a stalled attempt holds the
  slot, and every caller joining it" (`:14-16`).
- `SerializedWrites` (`oauth/authProgram.ts:16-63`): a one-permit semaphore
  plus a `queued` counter plus an `idle` Deferred, because "a single-permit
  semaphore alone cannot give the barrier" (`:10-13`).
- `sessionGeneration` (`SubscriptionOAuthCoordinator.ts:98`), bumped in
  `supersedeInFlightRefresh` (`:221-224`) inside the write's queueing
  segment, read in `stableSession`'s loop (`:206-218`) and three times in
  `performRefresh` (`:381-398`), with `sessionAfterSupersede` (`:233-256`)
  deciding what to hand back once superseded. Consumers: `SharedAttempt` 6
  refs in 3 files (exported from `node.ts:231` with no harness consumer),
  `SerializedWrites` 6 refs in 2 files.

**The design decision behind it.** "May a login or sign-out run while a
refresh is in flight?" The code says yes, and then needs three mechanisms
to make the outcome well-defined.

**The better design.** No. One `Semaphore(1)` per coordinator around every
operation that reads then writes the stored session (`freshSession`,
`storeTokens`, `signOut`, `loginWithCode`'s store). `freshSession` =
`withPermits(1)(load; if fresh → return; else Effect.uninterruptible(
exchange; store); return)`. Concurrent callers queue on the permit and find
the session fresh when they get in, which is the single-flight. An
interrupted caller holding the permit still completes the uninterruptible
exchange-and-store, which is the guarantee the detached fiber was for.
Deleted: `SharedAttempt` (file, 63 lines, and its test
`packages/llm/test/utils/core/sharedAttempt.vitest.ts`), `SerializedWrites`
(file), `sessionGeneration`, `stableSession`, `supersedeInFlightRefresh`,
`sessionAfterSupersede`, the generation checks in `performRefresh`, the
`policy.sessionChangedMessage` wording (2 uses).

**What we give up.** A sign-out or login waits for an in-flight token
exchange instead of superseding it (bounded by the HTTP client's timeout).
Risk: low; the refresh path is exercised by every subscription run.

**Change amplification.** "A coordinator gains a second stored secret (a
per-user client registration kept beside the session, which `registration`
already hints at, `subscriptionCoordinator.ts:139-146`)": today it must
join `SerializedWrites`, the generation and the supersede rules; after, it
is one more read-then-write under the permit.

---

## 7. The helper model is a special request inside the general bind, with a layer per call

**Red flags:** special and general code mixed; shallow pass-through;
nullable fields meaning one thing; an option with one caller; two answers
to "may the helper model serve now".

**Evidence.**

- `ModelAccess.bind` takes `BindRequest | HelperRequest`
  (`modelAccess/ModelAccess.ts:109-111`) and branches on `'purpose' in
  request` (`:201-210`). All `helperRequest` adds is the model name
  (`getHelperModelName ?? runModel`) and three constants
  (`declinedRoutes: [], textOnly: true, temperature: 0`, `:132-148`).
- `helperCall` builds `modelAccessLayer(stores)` per call
  (`helperModel.ts:66`) while runs take `ModelAccess` from the `AgentRun`
  layer (`AgentRun.ts:51-53, 328`): two constructions of one service.
- `retries?` is overridden by one caller (`sessionDescription.ts:160`,
  `retries: 0`); `runModel?` is an option for the same caller. Three nulls
  say "no run": `logger: null`, `record: null` (`helperModel.ts:100-102`),
  `asker: null` (`modelCall.ts:183`).
- Availability is decided twice: `applyHelperModelPreference`
  (`helperModelName.ts:59-87`) via `readModelOptions(...).unavailableReason`,
  and `helperRequest` via the bind itself (`ModelAccess.ts:132-133` "Its
  bind decides whether it can serve now").

**The design decision behind it.** "Is a helper call a run's call with
fewer parts, or its own thing?" Today it is both: the general path takes a
special request, and the special caller re-implements the general driver.

**The better design.** `helperCall` resolves the model name and calls
`access.bind({ modelId, declinedRoutes: [], textOnly: true, temperature: 0 })`;
`HelperRequest` and the `'purpose' in request` branch go. `ModelAccess` is
provided once per session (the `sessionModelAccess` layer `AgentRun.ts:51`
moves up to `sessionLayer`), so `helperCall` takes it from context. With
finding 1 the helper is one `Effect.retry` and `retries` is the caller's
number, not an option. `applyHelperModelPreference` keeps the one
availability read it has, and `helperRequest`'s second answer goes with it.
Deleted: `HelperRequest`, `helperRequest`, the per-call layer, `retries?`,
`runModel?` (the caller passes the model id it already holds).

**What we give up.** Nothing observable. Risk: low.

**Change amplification.** "A helper call needs a cache key": today
`helperModel.ts` request + `modelCall.ts` request plumbing + the
`HelperRequest` type; after, one field in the caller's `TurnRequest`.

---

## 8. Smaller red flags in `ModelInvoker` (batched)

- **A side table keyed by object identity.** `attemptStarts:
  WeakMap<InvocationRef, number>` (`ModelInvoker.ts:146-148, 433, 663-668`)
  prices a billed failure by when its attempt started. The key is the
  `ref` object the loop minted; an `observe` move's ref is a fresh object
  read from the rows (`invocation.ts:365-366`), so a failed observation is
  never priced. The fact belongs on the attempt (a `startedAt` the failure
  carries, or the attempt row's commit time). Two representations.
- **A failure row for an attempt that did not fail.** `reask` writes a
  `failed` row whose `error` is the synthetic `INTERRUPTED_RETRY_MESSAGE`
  with a `provider` (`ModelInvoker.ts:107-109, 722-735`) so the retry panel
  has something to show. A sentinel: "the process stopped mid-attempt" is a
  fact of the rows (`failed === null`, `inFlight.ts:220-228`), and the
  request can be opened from it without inventing a failure. With finding 2
  the request's payload carries the verdict or `{ kind: 'interrupted' }`.
- **Pass-through provision.** `ModelInvoker.call` re-provides `UsageLog` and
  `RouteRetries` it took from the same context (`:754-755`).
- **One mutable record, two writers.** `AttemptOutcome` (`:170-173`) is
  written by `eventSink` and by `submitAndObserve` (finding 3).
- **A stop reason read from the registry mid-interrupt.** `observeBackground`
  cancels only when `runs.stopCause(runId) === 'user'`
  (`run/backgroundTurn.ts:99-103`), reading the registry's in-memory
  `activation.stop` (`runRegistry.ts:172-173`). O2 makes the reason a
  `run.end` field, but that row is written after the interrupt. The
  interrupt itself can carry the reason: the dispatch path already reads
  `invoked.cause.reasons` (`loop/toolUseDispatch.ts:557-566`), so a user
  stop interrupts with a tagged reason and the finalizer reads
  `Cause.hasInterrupts`' reasons, not a registry. That deletes one of the
  15 `stopCause` reads and keeps the fact in one place (the interrupt, then
  the row).

---

## Good modules in this area

- `nextAttempt` / `failedNext` / `failuresBefore` (`shared/session/inFlight.ts:83-91, 212-284`):
  pure, over rows, the one reader of the budget. Keep as the model for
  finding 1's inlined loop.
- `backgroundLifecycle` (`packages/llm/src/api/background.ts:94-235`): one
  shape (`submit`, `observe: poll | stream`, `cancel`, `finalize`) over two
  wires, 9% comments, every provider difference inside the wire object.
- `configurationFor` and the `CONFIGURE` / `RESPONSES_ROUTES` tables
  (`api/configuration.ts:77-125, 135-188`;
  `api/responsesConfiguration.ts:150-214`): mapped types make a missing
  protocol or vendor a compile error; the rows are real behaviour, not
  constants (one column, `supportsForcedToolChoice`, is constant per
  `vendorRoute` call and could be data, but that is a nit).
- `verdict.ts` (`packages/llm/src/api/verdict.ts`): the one reading of a
  vendor reply; the harness should read its fields and nothing else
  (finding 2 is about the harness re-encoding them, not about this file).
- `filesApiUploads` (`api/uploadCache.ts:84-231`): a deep module over two
  providers' files APIs; its interrupt/release reasoning is real (an id
  with one owner at every instant) rather than ceremonial.
- `messageThreads` (`api/anthropicThreads.ts:142-271`): the replay,
  not-found and unsupported fallbacks are private to the module and the
  caller sees `send` and `finalize`.
- `contextTokens` / `outputBudget` (`run/contextTokens.ts`) and
  `priceTurnUsage` (`run/pricing.ts:21-54`): pure, one owner each.
- `attemptRows` / `checkRecordedRequest` (`run/requestContext.ts:138-166,
  340-362`): the "rows alone rebuild the request" invariant has one
  checker, in development only.

---

## Already settled, left alone

- **`ModelRetryGate` exists.** `.agents/docs/implemented/architecture/2026-09-20-single-owner-liveness-and-one-fold.md`
  §3 keeps it ("the provider"). Finding 4 proposes its implementation, not
  its removal; the per-route health it owns is not a row fact.
- **`binding?.backend ?? state.backend`, `BoundModel.declinedRoutes`, the
  backend as a constraint of `decideRoute`, the one reasons table.** Landed
  2026-11-04 per the one-fact note's area D ("Landed" paragraph). Not
  re-reported.
- **`closed` / shutdown-cut attempts** (`inFlight.ts:48-49, 88`,
  `runState.ts:327-334`): O2 deletes them with the stop-reason field.
- **`deadlineAtMs` absolute on the `accepted` row** (`backgroundTurn.ts:28-33`,
  `runHistoryEvent.ts:174-183`): a resume must observe under the original
  deadline; the constant per caller is the right owner for it.
- **The `attempt` row before the billed request and the `response` row
  before dispatch**: harness `AGENTS.md` "Write points are the contract".
- **`checkRecordedRequest` under `VITEST`/an env flag**: documented as a
  development check (`requestContext.ts:335-339`), not a production branch.
- **`ValidationModel` as a service option** (`routeDecision.ts:38-47`,
  `binding.ts:105-136`): a canned model for package validation builds is a
  real second route kind with its own binding; the `protocol === 'validation'`
  branch is one place.
- **Google background requiring `store`** (`protocol.ts:109-111`,
  `googleInteractions.ts:576-581`): a provider fact, owned by llm.
