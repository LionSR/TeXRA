# Post-refactor simplification sweep (2026-09-06)

A 54-agent `our-code-simplifier` sweep over everything `main` changed since the
`v0.40.8` tag, with two charter priorities on top of the standard rules:
**Effect-native** and **declarative**.

## Scope

414 non-test `.ts`/`.tsx` files changed on `main` in `v0.40.8..origin/main`,
minus the 163 files touched by the 12 then-open PRs (#11946, #11945, #11943,
#11942, #11936, #11928, #11926, #11922, #11921, #11919, #11893, #11818), minus
`src/test-kernel/` — **395 files, 108.5k lines, 69 of them already importing
`effect`**. Bin-packed by LOC into 54 disjoint, directory-coherent batches of
~2.2k lines each. Every agent got an explicit file list, never a directory
prefix.

The code under the sweep is the output of the session-fold PRD lanes, the
Effect v4 runtime migration, the progress-view and desktop-shell lanes, and the
session-ledger work. Freshly refactored code carries the shape of the old
design as scaffolding; that residue was the target.

## Result

**27 of 54 batches reported zero edits.** That is the headline. It confirms the
2026-08-20 whole-tree finding that per-file simplification is largely exhausted
here, and it now extends to code refactored within the last three days. The
agents did not manufacture churn to justify their runs.

The 27 that did edit produced 37 files, +267/−423 (net −156), 61 named elements
removed. By species:

- **Dead imports left by the fold refactor** — 7 in `packages/cli/src/chat/tui/App.tsx`
  alone (`AgentCategory`, `isPlainAgentIdentity`, `USER_FOLLOW_UP_SUPPORT`,
  `isActivePhase`, `isInFlightPhase`, `StreamView`, `streamPhaseOf`).
- **Single-caller pass-through collapses** — the clearest was
  `withOpenTurnUpdate` in `src/tools/inquiry/externalInquiryStorage.ts`, whose
  own docstring called it "the shared guard behind `recordAnswerForOpenTurn`"
  while having exactly that one caller.
- **Effect-idiom fixes** — `Stream.unwrap(Effect.sync(() => …))` →
  `Stream.suspend(…)` in `SessionEvents.ts`'s `readAll`/`readListing`. The
  agent correctly left the third `Stream.unwrap` alone: its body does real
  Effect work before producing the stream, so `Stream.unwrap(Effect.gen(…))` is
  the right idiom there.
- **Declarative hardening** — `SessionStores.ts`'s execution-deletion if-ladder
  became an exhaustive `switch` with a `never` guard, so a new
  `ExecutionDeletionOutcome` variant compile-fails instead of silently falling
  into the `retained` repair path. Net +LOC, justified under dispatcher-as-contract
  (#7159).

### One regression, caught by the central gate

`src/controllers/session/hostDraftRequests.ts`: factoring four
`Effect.tryPromise({try, catch})` blocks into a shared `tryPromise` helper is a
sound collapse, but at two sites it dropped an `async` that was load-bearing —
`runInSession` returns `Promise<X> | X`, and the original `try: async () =>
runInSession(…)` was coercing that union. Typecheck caught it; the `async` is
restored and the collapse stands.

This is the argument for the sweep topology: concurrent editing agents must not
run repo-wide gates (they read siblings' half-written files), so correctness
rests on a serialized central gate plus a fix wave. An agent verifying by
reading could not have caught this.

## The real yield: 261 skipped candidates

Agents were told not to port a non-Effect file to Effect — those lanes belong to
`docs/prds/2026-08-26-effect-4-runtime-migration.md` and several were in flight
on open PRs — but to record the opportunity instead. **78 of the 261 skips are
Effect-port opportunities**, and 24 name a hand-rolled primitive with a direct
Effect equivalent.

These are agent claims, and they do not survive inspection at anything like
face value. Five were spot-verified: **two held, two were refuted, one is
already being fixed elsewhere.** Treat the list as leads, never as a queue.

### Verified

| Site                                            | Finding                                                                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/goal/goalStore.ts`                   | Imports `Mutex` from `async-mutex` (line 1) _and_ `Effect, Fiber, Stream` (line 2) — two concurrency systems in one file; `indexMutex` wants an Effect Semaphore. |
| `src/telemetry/UsageLogService.ts` baseline row | The `import:p-timeout` row is stale — the file no longer imports it. Already dropped by #11951.                                                                   |

### Refuted

- `src/utils/core/perKeyQueue.ts` — reported as "a hand-rolled Deferred-chain
  lane that should be an Effect Semaphore/Queue". It already imports `Deferred`
  from `effect` and uses `Deferred.makeUnsafe`; the hand-off is a documented,
  deliberate design.
- `packages/cli/src/chat/tui/state/approvalQueue.ts` — reported as a raw
  `new Promise((resolve) => …)` latch that wants a `Deferred`. It is sound
  design, not scaffolding: `HostReservation.decided` is a **public
  `Promise<ApprovalDecision>`** that Promise-shaped callers await, and the
  resolver doubles as the reservation's **identity token** (`live()` tests
  `entry.settle === decide`, which is what makes every operation a no-op once
  the entry leaves the surface). A `Deferred` would change the public field and
  need `runPromise(Deferred.await(…))`, raising the file's `Effect.run*` count
  from 1 to 2 — a shrink-only ratchet failure.

### Why the remainder is not a work queue

Two structural constraints, both discovered by trying to schedule this list:

1. **Most sites are already owned.** #11951's `debtLanes` map assigns every
   below-boundary `Effect.run*` site to a named lane that will delete it:
   `OnboardingRefreshQueue`, `ProgressApiKeyRetryController`,
   `hostDraftRequests` and `UsageLogService` to _wave-1 rebuild — controllers,
   telemetry and session drafts_; `jsonStore` and `fileLocks` to _lane D —
   Platform ports become Effect-typed_; `goalStore` to _Phase 5 — tools
   subsystem_; `PollingSourceBase`, `memoryFileSystem` and
   `agentCliSessionRegistry` to _wave-1 tools_ (in flight on #11953);
   `SessionHandle` to _Phase 3_. Taking any of these ad hoc duplicates an owned
   lane.

2. **The ones nobody owns cannot be done yet.** `runExecution.ts`,
   `desktopDiffHost.ts` and `SupabaseAuthProvider.ts` sit at sanctioned
   boundaries but import no `effect` today, so porting each adds its first
   `Effect.run*` site. The ratchet is shrink-only — a file absent from the row
   fails — and `--update` refuses wholesale while 11 below-boundary files
   remain. They unblock when #11951 lands, not before.

The practical reading: this list feeds the lane program as evidence. It is not
a parallel work front, and it should not be fanned out to agents.

### Unverified clusters worth triaging

- **Hand-rolled deferred / latch**: `ExecutionHandle.ts` (`pDefer`),
  `packages/cli/src/runtime/runExecution.ts` (`pDefer` + `AbortController` +
  a hand-tracked `LaunchVerdict` union for shutdown-vs-publish racing),
  `desktopDiffHost.ts` (pDefer latch, Set-based in-flight tracking, manual
  double-empty drain loop), `progressFollowUpSubmit.ts` (manual `acknowledged`
  boolean latch for exactly-once ack), `sessionProgressSubscription.ts`
  (`drained` promise + `heldRosters`), `SupabaseAuthProvider.waitForSession`
  (manual `cleanupListeners`/`timeoutHandle` cancellation machinery).
- **`Data.TaggedError` → `Schema.TaggedError`**: `src/tools/memory/memoryFileSystem.ts`,
  `memoryMeta.ts`.
- **Whole modules still on Promise/try-catch**:
  `openAICompactionCoordinator.ts` (~650 lines), `RemoteAgentLoader.ts` /
  `remoteAgentList.ts`, and the `nodeWorkspace`/`nodeStores`/`nodeStorage`/`nodeHost`
  platform composition layer.
- **`AppSignals.ts`** — EventEmitter-based pub/sub, noted as a candidate for
  Effect `PubSub`. Weigh against its documented `AppSignals`-only scope before
  acting.

## Two pre-existing breaks on `main` (not from this sweep)

1. **`main`'s CI is red on the `@adapter-until` check.**
   `src/tools/github/PollingSourceBase.ts:413` carries an
   `@adapter-until 2026-11-05` marker (introduced 2026-09-06), and
   `scripts/check-effect-migration-ratchet.mjs` exits 1 on it — verified against
   a pristine `origin/main` worktree, and confirmed live: CI run 34030234404 on
   `main` fails at `static checks (linux) :: Check Effect migration ratchet`
   (`.github/workflows/ci.yml:214`).

   This is a two-PRs-combine-badly break, not a mistake in either PR. #11923
   (`b372da4b20`) introduced the marker while markers were still legal; #11920
   (`f2ec7435e6`), which merged **after** it, added the check that forbids all
   markers. Each was green on its own base. Per the owner's R1 ruling there are
   no temporary adapters, so the fix is converting that port and its callers to
   Effect, not extending the marker or relaxing the check.

   Consequence for any branch cut from `main`: it inherits this failure. This
   sweep's PR will be red on that step until `main` is fixed, and its red is not
   evidence about the sweep.

2. **The Effect baseline is stale and cannot be regenerated.**
   `--update` refuses: 11 files hold `Effect.run*` calls below the sanctioned
   boundary (`CodexSessionCoordinator`, `XaiSessionCoordinator`,
   `OnboardingRefreshQueue`, `ProgressApiKeyRetryController`,
   `hostDraftRequests`, `fileLocks`, `jsonStore`, `UsageLogService`,
   `agentCliSessionRegistry`, `PollingSourceBase`, `memoryFileSystem`). Until
   those migrate, the accumulated shrinks — including the stale `p-timeout` row
   above — cannot be locked in. This sweep therefore leaves the baseline
   untouched; it widens nothing.

## Method notes

- Single shared worktree, disjoint explicit file lists, no git commands and no
  repo-wide gates in the workers; serialized central gate afterwards. Gates run
  in order: format → lint → typecheck (all 6 tsconfig projects) → vitest →
  dead-code ratchet.
- Gate results: format ✓, lint ✓, typecheck ✓, **vitest 764 files / 9070 tests,
  0 failures**, dead-code ratchet ✓ (286 vs 286 baselined).
- `effect-solutions` (v0.5.3) was installed globally and Effect `main` cloned to
  `~/.local/share/effect-solutions/effect` so agents could follow the AGENTS.md
  "never guess at Effect patterns" rule. Worth keeping provisioned.
- Cost: ~5.8M subagent tokens, 1437 tool calls, 25 minutes wall clock for 54
  agents.
