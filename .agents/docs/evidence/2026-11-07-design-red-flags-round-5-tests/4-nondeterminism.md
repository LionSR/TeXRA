# Round 5, lens 4: nondeterminism in the suites

Commit: `main` at `c9ceb23` (`simplify(test): the fake host is a service, not
a module slot (R3-R R6) (#14826)`).

Scope: 290 suite files (`*.vitest.ts`, `*.spec.ts`, `*.live.ts`, `*_test.ts`
under `src/test-kernel`, `packages/*/test`, `packages/llm/test-live`,
`packages/desktop/tests/e2e` and `supabase/functions`; `support/` excluded
except where a suite copies it). Churn is the brief's rank where it has one,
otherwise "measured" (`simplify`/`refactor` subjects since 11-01).

## Numbers

| Primitive (suites only)                                                            | Files | Sites |
| ---------------------------------------------------------------------------------- | ----- | ----- |
| Outer `layer(...)` with `excludeTestServices: true` (whole block on the live clock) | 73    | -     |
| `it.live` or `excludeTestServices: true`                                            | 91    | -     |
| `TestClock` used at all                                                             | 14    | 37    |
| Forever-loop "clock pumps" (`TestClock.adjust` on a real tick)                     | 3     | 3     |
| Macrotask "settle" helpers (`setTimeout(resolve, 0)`)                               | 5     | 5 defs, 10 uses |
| `vi.waitFor` (18 of them on the default 1 s timeout)                                | 8     | 19    |
| Hand-written sleep-poll loops (`while … sleep`, `for … sleep`)                     | 6     | 8     |
| `vi.useFakeTimers` under an Effect service                                          | 1     | 1     |
| Fire-and-forget `runFork` in a suite (not joined, not scoped)                       | 5     | 8     |
| Module-level `let` (per-case state in module slots, or id counters)                 | 17    | 39    |
| `vi.stubEnv` / `vi.stubGlobal`                                                       | 11 / 3 | 32 / 5 |
| Playwright `expect.poll` (allowed: retrying readiness check)                        | 6     | 16    |
| `waitForTimeout`, `Math.random`, vitest/Playwright `retries`                        | 0     | 0     |

Nothing in CI or `package.json` runs `--sequence.shuffle`, the detector
`vitest.config.mjs:121-126` names for order dependence (finding 9).

## Findings

### 1. Three clock pumps turn the test clock into a fast wall clock, so no case can check a duration

**Flags:** reinvented primitive (a polling loop around `TestClock`); special
and general code mixed (live clock for the block, test clock per case).

**Evidence.**
- `src/test-kernel/agent/runtime/RetryState.vitest.ts:108-112` (churn 13):
  ```ts
  const pumpClock = Effect.forkChild(
    Effect.forever(
      settle.pipe(Effect.andThen(TestClock.adjust(RETRY_BACKOFF_MS * 10))),
  ```
  The block runs live (`:389`, `layer(SessionGraph.hosted, { excludeTestServices: true })`),
  and each case brings its own `TestClock.layer()` (`:377-385`) and then a
  pump that adds 10 s on every macrotask (`:400`, `:536`). A backoff of 1 s,
  5 s or 9 s gives the same result; the suite comment calls the 1 s value
  "the gate's base backoff" (`:99-100`) but nothing asserts it.
- `packages/harness/test/agent/runtime/HistoryQuery.vitest.ts:66-70`
  (measured 1): `TestClock.adjust('1 second')` then a real `delay(20)`,
  `Effect.forever`, against `QUERY_DEADLINE = '5 seconds'`
  (`historyQuery/HistoryQuery.ts:69`). A deadline of 1 s or 60 s passes.
- `src/test-kernel/tools/lean/LeanServerPool.vitest.ts:192-205` (measured 1):
  `settle` polls a log file every real 10 ms and adds 100 ms whenever a
  diagnostics line appeared.
- The root: 73 suites put their whole block on the live clock with a
  restated comment ("Live clock: the session's publisher and readers run on
  real turns", 5 copies verbatim, the rest paraphrased). No support module
  or guide says why the session needs it (`grep -i 'live clock'` over
  `support/` and both AGENTS files: nothing). The session's own timed code is
  a SQLite busy retry (`controllers/session/storeAside.ts:69-74`), close
  deadlines (`sessionOwners.ts:99-104`, `SessionEvents.ts:204`) and the
  decide retry (`effect/requestAnswerer.ts:49`). Whether any of them blocks
  a case under `TestClock` is **unverified** (it would need an edited suite).

**The design decision behind it.** Where a case's time comes from. The
session graph is shared at block level on the live clock, so a case that
wants virtual time provides a second clock below it and has no point at
which it knows the fiber reached its sleep, so it pumps.

**The better design.** Fork the program, wait for the signal that it is
waiting, then adjust by exactly the duration under test, as
`packages/harness/test/agent/runtime/ModelRetryGate.vitest.ts:93-96` does
(`TestClock.adjust(1000)` then `yield* probe.started`). In RetryState the
signal is the scripted model's attempt (`scriptedModel` already counts
`attempts()`): give it a `Deferred` per attempt, adjust
`RETRY_BACKOFF_MS - 1`, assert no second attempt, adjust 1, await it. In
HistoryQuery, adjust once by the deadline after the statement is running
(the store fiber's start is the signal; if none is reachable, keep one
stepping fiber but assert the refusal does not come before 5 s). Then
settle the live-clock question once: either `SessionGraph.hosted` provides
the live clock itself with the reason in one comment, and the 73 restated
comments go, or the session runs on `TestClock` and the per-case
`TestClock.layer()` plus pumps go. Deleted: `pumpClock` (1 def, 2 uses),
HistoryQuery's `stepping` loop, LeanServerPool's clock half of `settle`.

**What we give up.** Nothing a case checks today. Risk: an exact adjust
hangs if the signal comes too early; the case's `it.effect` timeout catches
it.

**Change amplification.** "Change the base retry backoff": today no suite
fails; after, RetryState fails at one line, as it should.

**Depends on:** none. RetryState is top churn; sequence with E's R3-E2 if
that PR touches it (**unverified**: no open-PR list was reachable).

### 2. "One macrotask" settles and absence checks after a fixed wait, including in the guide's exemplar

**Flags:** reinvented primitive (a sleep spelled `setTimeout(resolve, 0)`);
`addObserver` in a test; non-obvious code.

**Evidence.** Five copies of the same helper:
- `packages/harness/test/tools/Cancellation.vitest.ts:11-13` ("Let the
  forked request start"), used at `:45` before `TestClock.adjust`. This is
  the exemplar `src/test-kernel/AGENTS.md` ("Effect-based tests use
  `@effect/vitest`") points every new suite to.
- `src/test-kernel/cli/ExecuteCli.vitest.ts:68-70` (churn 10), used four
  times at `:373-392`, ending in an absence check after one macrotask:
  ```ts
  shutdown.addObserver(() => { shutdownResolved = true; });
  yield* settle;
  expect(shutdownResolved).toBe(false);
  ```
  If shutdown stopped waiting for the recovery write but took two
  macrotasks to finish, the case still passes.
- `src/test-kernel/cli/RunProgressRenderer.vitest.ts:25-29` (measured 5): six
  macrotasks ("a few turns of the event loop cover the stream pipeline"),
  then `detach` and `expect(records).toEqual([...])` (`:206-235`). A
  projection that needs a seventh turn fails the case with an empty list.
- `packages/harness/test/agent/followUp/ToolUseFollowUp.vitest.ts:41-43`,
  used once at `:390` after `followUps.closeInput(closed)`, whose fake log
  is synchronous (`:80-131`: `Effect.sync`, `Effect.succeed`). The settle
  is probably dead (**unverified** by a run).
- `RetryState.vitest.ts:103-105` again, inside
  `while (stub.attempts() < sent) yield* settle;` (`:582`).
- A smaller form of the same absence check:
  `packages/harness/test/agent/runtime/RunRegistry.vitest.ts:107-108`
  (`yield* Effect.yieldNow; expect(yield* Deferred.isDone(drained)).toBe(false)`).

**The design decision behind it.** How a case knows a forked fiber is past
a point. Each helper answers "long enough", which is the wall-clock wait the
guide forbids, moved to the event loop.

**The better design.**
- Cancellation: succeed a `Deferred` inside the request body after the
  abort listener is attached, and await it instead of `started`. The
  `TestClock` layer already tracks the racers' scheduler hops
  (`effect/dist/testing/TestClock.d.ts:23-25`).
- ExecuteCli: drop the observer and the absence check; record an ordering
  log (`'recovery written'` when `recoveryWrite` resolves, `'shutdown'` when
  `Fiber.join(shutdown)` returns) and assert the order. The two `settle`s
  around `stopRequest` become a wait on the `run.stop` the stub receives (a
  `Deferred` in `mocks.stopRequest`).
- RunProgressRenderer: wait for the `run.children` record in the captured
  output, as the first case in the file already does (`:154`), or have
  `detach` drain what the projection has seen.
- ToolUseFollowUp: delete the settle.
- RetryState `:582`: the per-attempt `Deferred` of finding 1.
- RunRegistry: keep `Deferred` ordering only; the absence after one
  `yieldNow` can be stated by awaiting `drained` after `release` and
  checking `generation` ended first.
Deleted: 5 `settle` definitions, 10 uses, 1 `addObserver`.

**What we give up.** ExecuteCli no longer observes "still pending at time
t", which it only sampled once anyway.

**Change amplification.** "Shutdown no longer waits for the recovery write"
(a regression): today ExecuteCli may or may not fail, depending on how many
macrotasks shutdown takes; after, the ordering log fails it every time.

**Depends on:** none. ExecuteCli and RunProgressRenderer may be in A's TUI
lifecycle PR (**unverified**); sequence with it.

### 3. `vi.waitFor` polls signals and arrays whose owners already publish changes

**Flags:** reinvented primitive (polling where a subscription exists);
two representations (a fake's array beside the event it records).

**Evidence.** 18 waits on `vi.waitFor`'s default 1 s budget, every 50 ms:
- `src/test-kernel/progressView/SessionSurfaces.vitest.ts:121`, `:150`,
  `:168`, `:178` (measured 5): poll `surfaces.get(KEY)?.surface$.get()`, a
  signal. The module under test subscribes to the same signals with
  `subscribeToSignalChanges` (`packages/texra/src/ui/progress/sessionSurfaces.ts:42`,
  defined at `packages/texra/src/shared/signals.ts:80-112`).
- `src/test-kernel/cli/TuiApprovalRetry.vitest.ts:238-250` (churn 9),
  `waitFor`/`waitForApproval` over `currentApproval`, a `computed` signal
  (`packages/cli/src/chat/tui/state/approvalQueue.ts:221`); 3 call sites.
- `src/test-kernel/cli/chatSessionController.vitest.ts:383`, `:433`, `:500`
  (churn 9): poll `session.runId` and `chatTuiCanStartRootRun(session)`; the
  controller publishes the same facts as `runStopFacts`
  (`packages/cli/src/chat/tui/state/sessionRunState.ts:62`), which the case
  reads right after (`:388-389`).
- `src/test-kernel/desktop/DesktopToolEditApproval.vitest.ts:155`, `:167`,
  `:185`, `:213`, `:229`, `:252`, `:261` (measured 4): poll `opened`,
  `staged`, `warnings`, arrays the suite's own fake UI pushes into
  (`:66-95`), `staged` through a `vi.spyOn` wrapper on `stagePreview`
  (`:90-95`). Two waits have 10 s; five have 1 s.
- `packages/harness/test/tools/BashTool.vitest.ts:83-88` (measured 5): polls
  `SessionViewAccess.run(runId)?.position` after `publishTestRows`. The
  support module has the subscribed form:
  `holdTestRun`'s `SubscriptionRef.changes(view.ref).pipe(Stream.takeUntil(…), Stream.runDrain)`
  (`src/test-kernel/support/sessionTestUtils.ts:90-96`).
- `packages/harness/test/tools/ExecutionsToolOutput.vitest.ts:107-112`
  (measured 3): polls a `vi.spyOn(toolUseFollowUp, 'wakeIfOwed')` call count
  (`:72-74`); the completion is also a `run.end` row on the view.

**The design decision behind it.** How a case waits for a published state.
The owners publish (signals, `SubscriptionRef`), and the suites sample.

**The better design.** Two waits, both over what the code publishes:
- for signals, one support helper `untilSignal(signal, predicate)` over
  `subscribeToSignalChanges`, returning an `Effect` that ends when the
  predicate holds (3 consumers: SessionSurfaces, TuiApprovalRetry,
  chatSessionController, so the rule of three is met);
- for the session view, the `holdTestRun` form (BashTool,
  ExecutionsToolOutput on the `run.end`).
DesktopToolEditApproval's fake UI pushes into `Queue.unbounded` per kind
and the case takes from it; the `stagePreview` spy goes. Deleted: 19
`vi.waitFor` sites, TuiApprovalRetry's `waitFor`/`waitForApproval` (2
helpers), 1 spy.

**What we give up.** Nothing. A wait that never comes now fails on the
case's own timeout (10 s) instead of after 1 s, with a less specific
message; the predicate can carry one.

**Change amplification.** "A slow CI host": today 18 waits can flake at 1 s;
after, none sample time.

**Depends on:** none. TuiApprovalRetry and chatSessionController are
likely in A's TUI lifecycle PR (**unverified**); sequence with it.

### 4. Forks no one joins: suites run work on `runFork` outside the test's scope

**Flags:** reinvented primitive (fire-and-forget where `FiberSet` or
`forkScoped` is the thing); error handling hidden (a failed fork is lost).

**Evidence.** R3-R found and fixed this in `publishTestRows` (now in the
caller's fiber, `sessionTestUtils.ts:31-42`). The suites still carry 8 sites:
- `packages/harness/test/tools/BashTool.vitest.ts:62`:
  `Effect.runFork(Context.get(session, Inbox).closeInput(parentRunId));`
- `src/test-kernel/agent/runtime/AgentRunLifecycle.vitest.ts:90-95`: a
  transaction forked from inside a `vi.spyOn(...).mockImplementationOnce`.
- `packages/harness/test/agent/followUp/ToolUseFollowUp.vitest.ts:147`: the
  fake inbox's `detach` runs `Effect.runFork(publisher.withPermits(1)(job(append)))`.
- `src/test-kernel/desktop/DesktopToolEditApproval.vitest.ts:74`, `:102`
  and `src/test-kernel/desktop/DesktopSettingsIpc.vitest.ts:77`, `:95`: the
  `spawn` port and the router answered with `runtime.runFork(program)`.

A fork that fails or outlives the case shows up later as a missing row or a
poll that times out (findings 3 and 6 wait on several of these).

**The better design.** Fork into the case's scope: `Effect.forkScoped`
inside `it.effect`, and for a host `spawn` port, a `FiberSet.makeRuntime()`
built in the case's scope so the scope's close waits for (or interrupts)
what it spawned and a failure fails the case. BashTool's
`detachBackgroundRun` becomes a yielded `closeInput`. (`processRuntime.vitest.ts:43`
is exempt: an unobserved fork is what it tests;
`WorkflowInputsLifecycle.vitest.ts:42` already joins through a `Deferred`.)

**What we give up.** Nothing.

**Change amplification.** "The inbox's close starts failing": today the
BashTool cases pass and the fiber dies unseen; after, the case fails where
it closed.

**Depends on:** none.

### 5. Per-case state in module slots, reset by hand

**Flags:** shared mutable state; temporal decomposition (a `setUp()` every
case must call first). Same species as R3-R's R6 (the fake host in a module
slot, fixed in #14826), now in the suites.

**Evidence.**
- `src/test-kernel/tools/ToolEditApprovalGate.vitest.ts:47-74` (measured,
  not ranked): `let host`, `let workspacePath`, `let session`, `let runId`,
  `let nextDecision`, `let decisions`, module-level `workspaceWrites`
  (`vi.fn`) and `relativeFiles` (`Map`), all reassigned by `setUp()`
  (`:150-166`), which each case calls as its first line. A case that skips
  it reads the previous case's session.
- `packages/harness/test/agent/followUp/ToolUseFollowUp.vitest.ts:57`
  (`let tryResume`), `:176` (`let recorded`), reset as a side effect of
  `fakeSession()` (`:194`).
- `src/test-kernel/cli/TuiApprovalRetry.vitest.ts:166` (`const started = new Set<RunId>()`)
  over one session for the file (`:280-285`), which needs
  `cancelOpenRequests` (`:95-115`) so "a request left open outlives its
  test on the file's session"; `rootRunId` is CLI module state reset there.
  The file has 2 cases.
- `src/test-kernel/cli/WorkflowRunCommand.vitest.ts:123` (`pendingRunStarts`,
  reset at `:139` and `:283`).
- Id counters instead of `generateRunId()`: `RetryState.vitest.ts:206`,
  `ToolUseDispatchParallel.vitest.ts:196`, `AgentRunLifecycle.vitest.ts:49`.
  A case's run id depends on which cases ran before it (`-t` changes it).

**The better design.** A case's state is a value its setup returns, or a
layer built per case: `setUp()` returns `{ host, session, runId, decide,
writes, files }` (ToolEditApprovalGate), `fakeSession(state, tryResume)`
takes the answer as an argument (ToolUseFollowUp), TuiApprovalRetry builds
its session with `buildPerTest: true` and deletes `started` and
`cancelOpenRequests`, and the counters become `generateRunId()`. Deleted:
about 14 module-level bindings, `cancelOpenRequests`.

**What we give up.** TuiApprovalRetry pays one session open per case (2
cases).

**Change amplification.** "Add a case to ToolEditApprovalGate": today it
must remember `setUp()`; after, the state it needs is what it destructures.

**Depends on:** none. TuiApprovalRetry: see finding 3's sequencing note.

### 6. ToolUseDispatchParallel waits on real sleeps beside its own latch pattern

**Flags:** reinvented primitive (sleep-poll); special and general code
mixed (two ways to hold a probe in one file).

**Evidence.** `src/test-kernel/agent/ToolUseDispatchParallel.vitest.ts`
(churn 11):
- `:538` `slow_barrier: probeTool(probe, 'slow_barrier', 5_000)`, a real
  5 s sleep, then `:552-556`
  `while (!probe.events.some((event) => event.startsWith('start slow'))) { yield* Effect.sleep(5); }`.
- `:486-489`: the barrier case holds `read_file` 20 ms and `write_file`
  10 ms of real time as the race window.
- `:431-447`, the case above it, already holds its probes on `Deferred`s
  (`slowStarted`, `never`).

**The better design.** `probeTool` takes only an `Effect` to wait on (drop
the `number` branch at `:120`) and records a `started` `Deferred`; the
interrupted case awaits `slow_barrier`'s start and holds it on
`Effect.never`; the barrier case holds `read_file` on a latch and checks
that `write_file` has not started before opening it, then that
`maxInFlight` is 1. Deleted: the numeric `wait` branch, the sleep-poll loop,
3 real sleeps.

**What we give up.** Nothing; the case gets about 5 s of wall-clock budget
back.

**Change amplification.** "A barrier lets the next call start early": today
the 20 ms window catches it on most hosts; after, the latch catches it on
every host.

**Depends on:** none.

### 7. UsageLogService fakes Node's timers under an Effect service instead of using `TestClock`

**Flags:** reinvented primitive (`vi.useFakeTimers` where `TestClock`
is the thing); state in module slots.

**Evidence.** `src/test-kernel/telemetry/UsageLogService.vitest.ts`
(measured 3): `:91-93` `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`,
and `vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)` at `:120`, `:149`,
`:209`, `:213`, with the block on the live clock (`:110-117`,
`excludeTestServices: true`). The service schedules its flush with
`Schedule.spaced(FLUSH_INTERVAL)` (`packages/texra/src/telemetry/UsageLogService.ts:590`)
and its backoff with `Schedule.exponential` (`:466`), so the suite fakes
the JS timer beneath Effect's live clock, and restates the interval as
`FLUSH_INTERVAL_MS = 30_000` (`:22`). The service's lifetime is a
`Scope.makeUnsafe()` in a module `let` (`:50-85`), closed by `afterEach`.

**The better design.** `it.effect` on the test clock,
`TestClock.adjust(FLUSH_INTERVAL)`, and the service built per case with
`it.layer(usageLogLayer(...), { buildPerTest: true })`. Deleted: the fake
timers, `lifetime`, `startUsageLog`/`stopUsageLog`, the restated constant.
The `vi.stubGlobal('fetch')` half is R3-R's (`R-test-infrastructure.md:615-621`).

**What we give up.** Nothing.

**Change amplification.** "Change the flush interval": today the suite's
copy must change too; after, it reads the service's.

**Depends on:** G9/R12, the `UsageLogService` rewrite as a queue and stream
(`../2026-11-07-design-red-flags-round-3/V-compromises.md:202`). Land this
with it, since the rewrite changes what the suite drives.

### 8. Waits on real processes are written five ways

**Flags:** repetition; reinvented primitive (`while … sleep` where
`Effect.repeat` with a `Schedule` is the thing).

These waits are allowed (`src/test-kernel/AGENTS.md`: a real subprocess),
but each suite writes its own:
- `src/test-kernel/tools/lean/LeanServerPool.vitest.ts`: `untilRoots`,
  500 × 10 ms (`:279-292`); `eventually` over `vi.waitFor` (`:210-211`); the
  `settle` loop (`:192-205`); the fake lake configured through the test
  process's environment (`vi.stubEnv` at `:146-147`, `:220`, `:250`) and
  polling its release file every 10 ms (`:43-46`).
- `src/test-kernel/tools/McpServerPlugin.vitest.ts:165-169` and `:278-281`:
  `while (…) yield* Effect.sleep(Duration.millis(20))` under
  `Effect.timeout`.
- `packages/harness/test/platform/processRuntime.vitest.ts:27-33`: 100 ×
  10 ms over a log capture, which could be a `Queue` the sink offers to.
- `packages/harness/test/utils/system/SystemUtils.vitest.ts:36-73`:
  `waitForCondition`.
- `packages/desktop/tests/e2e/serviceClient.spec.ts:117`:
  `for (let i = 0; i < 120 && alive(started.pid); i += 1) await sleep(250);`
  five lines above an `expect.poll` (`:122-124`) in the same spec.

**The better design.** In Effect suites, one form:
`check.pipe(Effect.repeat({ schedule: Schedule.spaced('10 millis'), until }), Effect.timeout(...))`,
with no shared helper (each site is one expression). The fake lake reads
its switches from a file in its own temp root, not the worker's
environment. processRuntime takes from a `Queue`. serviceClient uses
`expect.poll(() => alive(started.pid), { timeout: 30_000 }).toBe(false)`.
Deleted: `untilRoots`, `eventually`, 3 sleep loops, the `sleep` import in
serviceClient.

**What we give up.** Nothing.

**Depends on:** R3-R's `waitForCondition` item (`R-test-infrastructure.md:586-596`)
for SystemUtils.

### 9. The documented detector for order dependence runs nowhere

**Flags:** a comment substituting for a mechanism.

**Evidence.** `vitest.config.mjs:121-126`: "A shared worker runs file
after file, so file-order shuffles find those". `src/test-kernel/AGENTS.md`
names `--sequence.shuffle --sequence.seed=<n>`. `grep -rn shuffle .github package.json scripts`:
no match. Findings 5 and the env channel in 8 are what a shuffle would
find. `src/test-kernel/desktop/ElectronHostBridge.vitest.ts:38-39` stubs
`addEventListener` and `postMessage` with no `unstubAllGlobals` (contained
today only because `desktop/` is `isolated`).

**The better design.** Run the `pure` and `kernel` projects shuffled in CI
with a printed seed (one flag on the existing job), so an order-dependent
suite fails where it lands. No new test.

**What we give up.** A failure can come from a seed, not the diff; the
printed seed makes it reproducible.

**Depends on:** none.

## Good suites worth copying

- `packages/harness/test/agent/runtime/ModelRetryGate.vitest.ts:78-122`:
  fork, `TestClock.adjust` by the exact backoff, await the probe's
  `started`, assert.
- `packages/llm/test/auth/DeviceAuthorization.vitest.ts:29-50`: adjusts to
  9 999 ms and then 1 ms, so the interval itself is asserted.
- `src/test-kernel/utils/system/SemverUpdateCheck.vitest.ts:21-36`:
  `TestClock.setTime` for "now".
- `src/test-kernel/cli/WorkflowInputsLifecycle.vitest.ts:41-60`: a forked
  program reports its point through a `Deferred`.
- `src/test-kernel/tools/lean/LeanTools.vitest.ts:15-48`: a child process
  gated by files it writes and waits for, with a self-kill after 30 s.
- `src/test-kernel/controllers/session/sessionEvents.vitest.ts` (1,560
  lines, top churn): no sleeps, waits or clocks; churn there is lens 1's
  question, not this one.
- `holdTestRun` (`src/test-kernel/support/sessionTestUtils.ts:80-96`): the
  subscribed wait finding 3 asks the suites to use.

## Already settled, left alone

- `testHttpClientLayer` and `vi.stubGlobal('fetch')` (UsageLogService,
  GoogleInteractions): R3-R, `R-test-infrastructure.md:615-621`.
- `waitForCondition` and `ToolAvailabilitySeeding.vitest.ts:55`:
  R3-R, `R-test-infrastructure.md:586-596` (PlanTool and
  ToolEditApprovalGate already moved off it).
- The scripted model's release-file poll (`validationModel.ts:108-113`):
  R3-R, `R-test-infrastructure.md:389-391`.
- `publishTestRows`' unjoined fork: R3-R, landed (`sessionTestUtils.ts:31-42`).
- Real sleeps and polls on a real subprocess, mtime or socket (SystemUtils,
  McpServerPlugin, LeanTools): allowed by `src/test-kernel/AGENTS.md`
  ("A real sleep is acceptable only where wall-clock time is the thing under
  test"); finding 8 is only about their form.
- Playwright `expect.poll` (16 sites in 6 specs) and `test.setTimeout`: the
  E2E hygiene rule allows retrying idempotent readiness checks; no
  `waitForTimeout` and no `retries` anywhere.
- `screenshots.spec.ts:233` `Date.now()`: passed to the component as its
  `now` input, so the render is relative and stable; screenshots there are
  outputs, not baselines.
- `supabase/functions/*_test.ts` patching `globalThis.fetch` and `Deno.serve`
  with restores in `finally`: the edge functions read globals at the Deno
  boundary; the same species as R3-R's fetch item, and each `index.ts` is
  imported by only one test per file, so Deno's module cache adds no order
  dependence.
- Live LLM suites (`packages/llm/test-live`): no sleeps, retries or clocks;
  the 180 s timeout is the provider's (`vitest.live.config.mjs:33`).
- Module-level `let` fixtures assigned in `beforeEach` (SessionSurfaces,
  LeanServerPool paths, DesktopWorkspaceIpc, the e2e `launched` handles): the
  ordinary Vitest hook pattern, reset every case.
