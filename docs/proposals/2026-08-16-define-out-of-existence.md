# Define it out of existence: invented edges and self-inflicted races (2026-08-16)

> **Status:** Adjudicated audit + removal plan, pinned to origin/main
> `9d7cfa1899`. Seventh doc of the consolidation program. Executes two
> maintainer rulings recorded 2026-08-16: _"we invent problems and engineer
> complex solutions where the smart way is to define the edge situation out
> of existence"_ and its race corollary _"a lot of handling of race
> conditions, while the way should be to improve the architecture so they
> never race."_ Method: three multi-agent workflows (18 agents) — two
> invented-edge waves over runtime/UI/contracts and
> flows/persistence/tools, plus a race-machinery census over core and all
> four host packages — with every "definable-away" verdict passed through
> an adversarial verifier whose brief was to **prove the edge reachable**
> (a wrong verdict here deletes a load-bearing guard, the worst failure
> class this audit could produce). 4 of 8 race candidates and 1 of 8
> wave-1 candidates were struck down that way and are recorded in §4 so
> they are never re-flagged.

The scoreboard: **~40 race mechanisms + ~30 edge handlers censused →
15 verified deletions (≈ −350..−400 LoC of pure handling machinery),
2 structural findings that delete whole apparatuses, and ~35 honest
negatives** (guards that survived attack and stay, several with named
crash/cross-process/user-simultaneity boundaries).

## 1. Verified deletions — the edge becomes unrepresentable

Each row survived adversarial verification with an exhaustive producer
census. Format: machinery → construction-level fix → what deletes.

### 1a. Launch/resume intent (runtime)

- **D1. The fresh/resume inference + second id mint** —
  `runAgent.ts:104-106` infers "resume" from "has an executionId", so the
  CLI's pre-minted fresh ids need a compensating `registerExecution`
  boolean at 6 call sites, and forgetting it silently turns a fresh launch
  into a phantom resume. Verified: all 7 producers are in-repo callers;
  the SDK can never pass an id. **Fix:** the request carries explicit
  intent — `{kind:'fresh', executionId?} | {kind:'resume', executionId}`.
  Deletes the second mint, the `shouldRegister` heuristic, and the boolean
  at all sites; phantom-resume becomes a type error. (~25 LoC + the C5
  fallback already tabled.)
- **D2. Optional resume-cancellation predicates** — `canAcquireResumeLease`
  plus `isCancellationRequested` threaded optionally through 4 layers; the
  edge is "host forgets the guard" — and **the extension is the live
  producer** (it computes the predicate and never threads it down;
  audit-doc V4b). **Fix (adjusted on verification):** a **required sync**
  `isCancellationRequested` on `ResumeQueuedToolUseOptions` (the
  flow-attachment consumer is synchronous and cannot await); the async
  lease refinement stays a separate member. Closes the extension hole by
  construction; deletes the optional-threading arms (~20 LoC).
- **D3. `compensateFailedActivation`'s trace guard** — `runTrace?` and
  `activatedStreamId?` are two independent optionals with a single writer
  that always sets both. **Fix:** one atomic
  `activated?: {streamId, runTrace}`; the `if (runTrace)` guard deletes.
- **D4. Dead `RestartRepairOptions.expectedStatusGenerations`** — declared,
  passed, never read (the check closes over its own snapshot). ~8 LoC.

### 1b. Flows / engine (wave 2 — all CONFIRMED under constructed attacks)

- **D5. The keyless-leftover migration branch** (`runToolUseFlow.ts:482-526`,
  ~45 LoC, self-described "defensive fallback only") — every resume path
  passes `resume`; every fresh launch mints fresh; the two residual
  reachers (crafted execute args, 48-bit id collision) are cases the
  branch **mishandles silently today** (adopts a foreign run's record).
  **Fix:** fresh launch + existing record throws `PersistedFlowStateError`
  — loud, and _more_ correct for both residual cases. Drops the flow's
  `migrateSharedState` import; the retrieval boundary keeps sole ownership.
- **D6. The `_persistent401Error` latch** (~12 LoC) — vestigial since 401
  became non-auto-retryable; verified against all three attempt sources
  including the engine's clone-per-step construction.
  (`_hasAttemptedTokenRefresh` stays — live producers.)
- **D7. Dead WAITING self-edge** (`waitNode.on(WAITING, waitNode)`) —
  `PersistedFlow` short-circuits before successor lookup; verified the
  deletion cannot renumber persisted cursors (BFS id derivation skips
  already-indexed targets). Plus the stale engine comment.
- **D8. `maxRetries < 1` warn+clamp in the engine** — no producer can go
  below 1 (validated settings floor + `Math.max`); keep exactly one clamp
  (constructor), delete the warn arm.

### 1c. Persistence / tools (wave 2)

- **D9. `StreamLogStore.appendEntry`'s released-stream throw + `assertOwned`'s
  third disjunct** — three layers each exclude the guarded state one layer
  up (verified against two-writer-token, hydration-window, and eviction
  attacks). Collapse to the single acquisition-time fence.
- **D10. `ExecResult.timedOut`/`exitCode` optional → required** — every
  producer funnels through constructors that always set both; zero parse
  sites; no serialization boundary. Deletes ~15 LoC of sentinel arms
  across 5 files; the missing-field edge becomes a **typecheck error**.
- **D11. `StreamSubscriptionRegistry.bind()`'s sentinel-placeholder dance**
  (~20 LoC: no-op disposable, mutable `onEvent` reassignment, `keyIsNew`
  pre-read, rollback catch) — subscribe-first / insert-on-success /
  emit-after-insertion survives the strongest constructed attack; three
  cheap implementation riders recorded in the verifier note.

### 1d. Projection / UI (wave 1 — two falsify earlier "keep" rulings)

- **D12. The TUI `isStaleDispatch` generation apparatus (~70 LoC)** —
  verified **zero producers**: `SessionEventHub.emit` is fully synchronous
  with no replay-on-attach; the adapter skips the applier's only async
  handler; both `resetCliState` producers run in separate tasks. The guard
  cannot fire. _This falsifies the lifecycle doc's "generation machinery =
  view-root store in disguise, migrate it" ruling — it deletes outright._
  Rider: if U2 ever makes a renderer callback async, the guard belongs at
  that single async point, not restored globally.
- **D13. The webview `pendingDescriptions` race buffer (~30 LoC)** — the
  description-before-registration edge cannot occur (same-task synchronous
  emission, FIFO postMessage), and in every constructible detached-window
  interleaving the buffered value is never the only copy (durable-meta
  merge + roster description backstop). Outcome identical with and without
  the buffer.
- **D14. `StreamScopedPayload.executionId`** — no emitter sets it, no
  consumer reads it; the three NDJSON spreads always take the empty arm,
  so the public wire is **byte-identical** after deletion (~15 LoC).
- **D15. The #10693 topology guard — definable away at its emission site**
  _(adjusted-for, then resolved in favor of deletion)_: the
  detach-before-refresh interleaving is a deterministic sequence
  `detachActiveChildren` itself chose (per-child null edges, then roster).
  **Fix:** reorder the one emitter — silent detach → `child.activity`
  roster (retention stamps normally) → explicit null edges
  (`setParentStream` already preserves retained placements). The
  marker-refresh third loop becomes unreachable and deletes (~30 LoC +
  comment mass). Two verified riders: `sessionStores.onChildrenDetached`
  (the second null-edge emitter, fires on stream deletion) is safe but
  must not move ahead of roster emission; the reorder changes public
  NDJSON fact _order_ (same information) — note for headless-parity
  review. This is the clean ending for the #10693 WATCH: the machinery
  its reviews hardened gets deleted by making the edge impossible.

### 1e. Race machinery (census — verified)

- **D16. `SubscriptionUsageService`'s four-layer stack** — TTL cache +
  single-flight + generation counters + monotonic-request arbitration with
  recursive re-dispatch, for one staleness problem. The variant resolve is
  sync in production, so it joins the cache key; the existing
  identity-checked commit covers the one irreducible boundary
  (credential-change vs in-flight fetch). Deletes `generations`,
  `latestRequests`, `nextRequestId`, both re-dispatch branches
  (~50-60 LoC). Implementation caveat: use a TTL cache shape +
  delete-before-call for forceRefresh (the shared `coalesceAsync` lacks
  TTL).
- **D17. `ServerSideKeyService._activeFetchToken`** → promise-identity
  compare (~10 LoC; representation swap, the boundary stays guarded).
- **D18. The CLI's dual exit teardown** — `exitNow` duplicates
  `gracefulTeardown` (~30 LoC) and forces the `exiting` re-entry guard.
  One cause-parameterized teardown with exactly one caller; verified
  feasible including the double-tap-Ctrl-C escape semantics (force causes
  skip the queue drain and `runPromise` await). The guard genuinely
  deletes.
- **D19. `runExecution`'s launch-window flags (narrowed)** — register a
  stub handle synchronously at `executionId` assignment so `kill(id)` is
  authoritative from t0; deletes the `onRun` re-check,
  `runLifecycleStarted`, and one disjunct. (The rest of the flag lattice
  is OS-signal territory and stays; the SDK's `interruptPending` buffer
  falls out of the same change.)

## 2. Structural findings — whole apparatuses, delegation-substrate-sized

- **S1. One persisted resumability authority.** The waiting-repair probe
  apparatus (~90 LoC + `StreamStatusMachine`'s generation surface) exists
  because **two persistence authorities** (stream phase vs flow-resume
  record) can disagree after a crash. A single authority deletes the
  entire apparatus — the purest instance of the ruling at architecture
  scale. Coordinate with the substrate program; not a quick PR.
- **S2. One follow-up delivery authority.** Delivery-id replay suppression
  exists because live push AND persisted-cursor replay can both submit.
  Single authority (cursor delivers; live path only wakes) deletes the
  suppression — and independently, **D-adjacent finding: the in-memory
  dedup set is producer-less today** (cross-restart redeliveries carry
  _different_ ids, so the set couldn't dedup the one real replay source
  anyway). Deleting the dedup arm now is a maintainer ruling against
  #9664's declared future-outbox intent — flagged for your call;
  `turnToken` attribution stays either way.

## 3. Kept with adjustment

- **Approval-queue cycle guard**: edge confirmed unproducible today, but
  deletion converts a future producer bug into an infinite loop on the
  approval hot path. Keep as 6 LoC of insurance or convert to a loud
  throw-on-revisit (same size, better failure mode).
- **Round-update reset/merge wire protocol — REFUTED, keep**: the verifier
  found the real producer (non-authoritative unseeded reads during lazy
  rehydration) and a factual error in the deletion case (the `reset` arm
  is the _only_ path that propagates `clearMissingOutputs`). Deleting this
  first requires seed-authoritative sender reads — a store redesign.
  Recorded so nobody re-proposes the UI-side deletion.

## 4. The irreducibility register (survived attack — do not re-flag)

Race guards with verified genuine boundaries: the three auth credential
cells (rotated-once refresh tokens; three hand-rolled copies of one
pattern — merging would net-add, flagged not recommended), catalogue/key
invalidation (`coalesceAsync` idiom), stream reservations
(`tryAcquire` fused check-and-claim), interaction attachment machinery +
`executionInteractionOwnership` (the ownership-transfer cure already
applied), follow-up queue `generationId` fencing (detached producers
deliberately outlive continuations), wake-vs-stop check-after-await,
workflow journal (order-independence by data model — the best cure
species), transcript store per-key queues, tool abort races
(SDK-limitation `Promise.race`), resume-vs-delete admission, restart
repair core (crash + cross-process lease contention). Edge handlers with
verified producers: the double-finalize dance (fs throws mid-cycle),
abort-during-backoff forwarding, `shouldSkipCycle` (net-0 to reshape),
`inspectStableAttempt`'s crash arms, the resume drift self-heal (until
lease exclusivity is proven airtight), startup double abort-check,
`ToolUseWaitNode` consume-once, retry-gate credential branches, every
error-classification arm (external producer shapes). **Refuted-as-deletable
and stays:** `ModelCell` retirement guards (reachable via `/model` racing
a child-result wake into a WAITING parent), `storageGeneration` (it IS the
per-pass cancellation token; supersede lands mid-await),
the CLI interrupted-follow-up shadow buffer (the dying flow still owns the
durable queue's lease — some holding pen must exist), the onboarding
funnel's edge-trigger (protects a user choice from level-triggered
re-stomping; the extension's _unserialized_ twin is a latent stale-push
bug — fix by adding the desktop's serialization via `PQueue`, the one
place machinery should be _added_).

## 5. Execution shape

1. **Mechanical batch, no ruling** (one or two PRs): D3, D4, D6, D7, D8,
   D9, D10, D14, D17 (~90 LoC of pure deletion + one type tightening).
2. **Small reshapes, one PR each**: D5 (throw), D11 (bind reorder), D12,
   D13, D16, D18, D19 — each deletes its machinery in the same PR, R6/R8
   per the checklist, and each cites this doc's producer census as the
   R8 evidence.
3. **D1 + D2** (launch intent + required cancellation) — one runtime PR;
   closes audit-doc V4b by construction.
4. **D15** (emission reorder) — lands with or after the #10693 follow-up;
   resolves that PR's WATCH; carries the two riders.
5. **Rulings for you**: S2's dedup deletion (against #9664's future
   intent); the funnel-serialization add (extension gains the desktop's
   `PQueue` — a rare sanctioned addition); S1 scheduling.

Every PR body carries the §5b ledger discipline: the _deleted_ machinery
is the paired deletion; no new names are introduced anywhere in this doc.
