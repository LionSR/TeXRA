---
created: 2026-09-11
updated: 2026-09-11
status: proposed
---

# Effect-native test suites: what the corpus still carries

> **Status:** surveyed on `main` at `0e8f6d54a4` on 2026-09-11. Twenty agents
> read all 796 files under `src/test-kernel/` (about 220k lines) in
> LOC-balanced partitions given as explicit file lists. They produced 98
> candidates and 270 recorded rejections. One clustering pass merged the
> candidates into 17 themes and dropped 9 whose subject is on the 1.0
> retirement boundary. Each theme then went to two refute-by-default verifiers
> working on a later `main` (`756fbfb707`, after #12223 pruned 123 test files).
> One prototyped the theme on a representative file in a scratch worktree and
> ran vitest and the test-kernel typecheck. The other checked it against
> ownership, policy and value. Nine themes survived both lenses, in whole or
> in part, and are proposed below. Eight were refuted, and the reasons are
> recorded at the end. Rechecked against `4bc68a85c3`, after #12246 merged.

This note is evidence for the tracker that owns the topic, #12077 ("Testing on
`@effect/vitest`"). It does not reopen that tracker's rulings. TestClock
replaces fake timers only where the code under test is already Effect. A
converted subsystem's tests should provide a layer instead of `vi.mock`. And
there is no whole-suite migration. The themes below stay inside those rulings.
Almost all of them take something out of a test harness; none adds a layer.

## 1. `try/finally` inside `Effect.gen` is not cleanup (correctness)

On the pinned `effect` 4.0.0-rc.112, when a yielded effect fails, dies or is
interrupted, the generator driver returns the failure without calling
`iterator.return()`. So a `finally` around a `yield*` does not run. Both
verifiers checked this with a runtime probe: the finally is skipped after a
yielded `Effect.fail` and after a rejected `Effect.promise`, and it runs only for
a synchronous throw. `Effect.acquireRelease` and `Effect.addFinalizer` run in
all three cases. A failed `expect()` is a synchronous throw, so the common case
still cleans up. The harm is a secondary cascade after a test that is already
red, and it matters only where the skipped cleanup restores state that later
tests in the same worker can see.

At `756fbfb707` there are 12 generator `finally` blocks with a `yield*` in the
`try` (excluding the doomed `JsonStore` suite). Four of them guard shared state:

- `src/test-kernel/cli/OnboardingState.vitest.ts:59` restores the process-global
  `process.stdout.isTTY`.
- `src/test-kernel/agent/runtime/DefaultSessionLifecycle.vitest.ts:186` runs
  `teardownDefaultSession`.
- `src/test-kernel/tools/ToolAvailabilityAppSignals.vitest.ts:40` releases a
  global `AppSignals` subscription.
- `src/test-kernel/agent/followUp/ChildRunProgressEvents.vitest.ts:496` and
  `:556` restore a spy (`vitest.config.mjs` sets no `restoreMocks`) and clear
  default-session run status.

The rest release a local object whose leak cannot reach another test.

**Proposal.** Add one sentence to the `@effect/vitest` rule in AGENTS.md: inside
`it.effect`/`it.live`, cleanup goes through `Effect.addFinalizer` or
`Effect.acquireRelease`, never `try/finally` around `yield*`. This PR makes that
edit. Then convert the four shared-state sites to
`yield* Effect.addFinalizer(() => Effect.sync(restore))`. The prototype
converted `InquiryContinuationSession` (4/4 passing, typecheck clean, −3
lines).

**Not proposed.** The survey also wanted to move the 15 remaining
`Effect.promise(() => makeTempDir(...))` sites onto a scoped temp-dir helper, and
to add `scopedTestSession`/`scopedTestLaunchContext` support helpers. Both are
dropped. `useTempDirs` already cleans up in an `afterEach` whatever the
outcome, so moving those sites fixes nothing, and the helpers would be new
surface for a handful of sites. The survey's −250 lines was really about −35.

## 2. One test builder for the bare process runtime (bounded; tech-debt issue)

The same `initProcessRuntime(ManagedRuntime.make(Layer.mergeAll(testHttpClientLayer,
Layer.mock(UpdateCheckRecords, {}), inquiryRecordsLayer(...))))` block is copied
by hand into five suites, and a sixth copy lives in the shared setup:

- `src/test-kernel/settings/AgentHandlersDelete.vitest.ts:147-161`
- `src/test-kernel/desktop/DesktopAgentSettingsController.vitest.ts:46-59`
- `src/test-kernel/cli/CliSupabaseAuth.vitest.ts:79-99`
- `src/test-kernel/cli/ClipboardText.vitest.ts:90-104`
- `src/test-kernel/desktop/ElectronAgentDirectories.vitest.ts:89-111`
- `src/test-kernel/support/setupPlatform.ts:81-95`, whose copy deliberately
  mocks `InquiryRecords`

The copies have to change together. Commits `090ce86bc4` and `5969bba079` each
edited all six, and open PR #12106 edits all six again to add `NodeFileSystem`.
The 1.0 plan §C will widen the runtime's requirements further. The first two
suites also never dispose their install, and each install carries a persistent
`databaseLayer`. Beside the copies, `setupPlatform.ts:81` probes with
`try { effectRuntime() } catch {}` where the non-throwing `tryProcessRuntime()`
(`src/platform/processRuntime.ts:35`) exists. And `sessionGraphTestSetup.ts`
keeps an `installed` latch that nothing can reach: its only caller is its own
module body, and the export has no consumer.

**Proposal.** One `bareProcessRuntime(opts?)` in `src/test-kernel/support/`,
used by `installFakeHost` and the five suites, with the inquiry layer as an
option. Three of the suites install the real layer today. Swap the probe for
`tryProcessRuntime()`, drop the latch and its export, and replace the verbatim
copy of `createTempDirPlatform` in `ChatExportController.vitest.ts:40-54`. That
is about −100 test lines and no production change. The larger payoff is going
from six copies that must move together to one. Land it before #12106 or
rebase over it. The survey's matching claim about the TUI host-interaction
harnesses was refuted: the two harnesses differ, so sharing them would need a
superset.

## 3. Stub shape: doubles for Effect-returning exports return Effects (rule on #12077)

Suites that fake an Effect-returning production function often use a Promise
`vi.fn` and lift it back with `Effect.tryPromise` inside the `vi.mock` factory.
The CLI run-command suites go further: they lower the production callback with
`Effect.runPromise(args[4](inputs))`, which runs the command's inner program on
a detached default runtime. A broad grep finds 58 such bridges in 21 files. About
17 of them fake `getRunRecords` (`RunKVStore`), which is on the retirement
boundary. That leaves about 40 in about 17 files. The bare
`Effect.tryPromise(() => ...)` form also hands the subject `Cause.UnknownError`
rather than the rejected `Error`.

The prototype converted `AgentsRunCommand` and collapsed
`support/agentStorageFinalizationMock.ts` to one line. Doubles became
`mockReturnValue(Effect.succeed(...))`, factories re-export the `vi.fn`
directly, and bodies became `it.effect`. It passes 4/4 plus 14/14 for the sibling
`MultiAgentRunCommand` suite, typechecks clean, and nets −31 lines. One pattern
is needed for sibling suites: `runToolUseAgent` throws `CliUsageError`
synchronously inside its generator, which is a defect rather than a typed
failure. So a rejection test needs `Effect.flip(Effect.sandbox(...))` with
`Cause.squash`, not `Effect.flip` alone.

**Why this is a rule, not a PR.** #12222 reverted #12214's body conversion of
`AgentsRunCommand` the day after it landed. One-run-model steps S2 and S5 will
rewrite these suites' assertions again. A standalone conversion on this seam
would be undone the same way. **Proposal:** record on #12077 that when a
suite's bodies move to `it.effect`, its doubles for Effect-returning exports
move to `mockReturnValue(Effect.succeed/fail)` in the same edit. Bodies must not
be converted first. Apply it in the S5 CLI-projection PR. When converting,
re-check any
`invocationCallOrder` assertions, because an Effect-returning `vi.fn` records its
call when the effect is built, not when it runs:
`WorkflowRunCommand.vitest.ts:699`, `RunAgentOwnership.vitest.ts:238-241`.

## 4. The native-llm codec suites are half-converted (do with the llm lanes)

`AnthropicMessages`, `GoogleInteractions`, `OpenaiChat` and `OpenaiResponses`
all import `@effect/vitest`, yet still run the `Model` contract under test
through `Effect.runPromise` in plain async bodies. The contract is typed as
Effect/Stream at `packages/llm/src/turn.ts:1652-1660`. `OpenaiResponses` also
builds the tester's runtime by hand, as
`Effect.runPromise(Effect.scoped(...)).pipe(Effect.provide(TestClock.layer()))`,
at `:1040-1075` and `:1714-1736`.

Two corrections to the survey. Converting these bodies does not delete lines:
#12214's mechanical conversion of 52 suites came out net +859, and the sibling
`OpenrouterChat` came out +38. And `OpenaiResponses` does contain #12214's
skip-(c) races: `Effect.runFork` plus `vi.waitFor` polling at `:482-500`,
`:1211`, `:1493` and `:2469`. Those need a `Deferred` probe in the fetch fake
before they can convert. Twelve commits have touched `src/test-kernel/llm` since
2026-09-07.

**Proposal.** Convert opportunistically in whichever llm-lane PR next touches
each file. Start by dropping the two hand-provided `TestClock.layer()` wrappers
and the hand-built scoped runtime, which is the only part that actually deletes
code. Do not open standalone per-file PRs on this seam.

## 5. When the test's own fake owns the moment, signal it (rule)

A test that waits for something its own fake does should not poll for it. The
fake can complete a `Deferred` or open a `Latch`, and the test awaits that. At
`c789469685` there are 25 `Effect.promise(() => vi.waitFor(...))` sites in about
11 suites. Most of them poll real I/O or subjects on the retirement boundary, and
those should stay. The ones that poll a flag the harness itself writes are the
candidates:

- `src/test-kernel/controllers/ProgressApiKeyRetryController.vitest.ts`. The
  subject's routing lane is an Effect `Semaphore`
  (`ProgressApiKeyRetryController.ts:66`). The prototype replaced two `p-defer`
  gates with `Deferred` and three polls with a `Latch` opened from the mock:
  20/20 passing, typecheck clean, −5 lines. The ordering checks no longer depend
  on `vi.waitFor`'s timeout.
- `src/test-kernel/tools/lean/JsonRpcConnection.vitest.ts:13-99`. The
  connection's seams are a `Stream` and a `Sink`. The test still routes bytes
  through `PassThrough` pairs, a `Stream.callback` adapter and a Content-Length
  re-parser polled by `vi.waitFor`. It could instead feed input from a `Queue` and
  collect output into one, about −30 lines. Not prototyped.
- `src/test-kernel/cli/SlashCommandDispatch.vitest.ts:222-233` keeps a file-local
  `deferred<T>()` that duplicates `support/asyncTestUtils.createDeferred`. The
  preload seam it gates already returns an Effect.

**Proposal.** Record this as a review expectation on #12077, with the two
exemplars. Apply it when a suite is touched, not as a sweep. The survey's −140
lines was really about −60 to −80, at roughly one line per site. Out of scope:
`resumeRun`, whose subject is checkpoint resume, and `ToolUseFollowUp`, whose
queue is lane #12074 B11.

## 6. Bounded deletions ready to file as tech-debt issues

Each of these was prototyped by a verifier, with all tests passing, and survived
a separate policy check. The patches are kept with the survey record for
whoever implements.

**6a. Retire the per-test module re-import harnesses that outlived their
reason** (T06; about −78 lines proven, about −210 estimated).

- `PRPollingSourceCiStarted.vitest.ts` and
  `PRPollingSourceAnnotationPages.vitest.ts` run `vi.resetModules` +
  `vi.doMock` + `await import` on every test through
  `support/githubClientMock.ts`. Nothing needs a fresh module registry. The only
  module state is `SharedAnnotationFetchBudget`, which the drain test resets
  explicitly. The fake module also replaces the real `GitHubAuthError`,
  `GitHubRateLimitError` and `GitHubPermanentError` with look-alike classes, so
  production's `instanceof` checks (`PRPollingSource.ts:744, 841, 844`) run
  against fakes. A hoisted partial `vi.mock` with an `importOriginal` spread
  keeps the real classes. The prototype passed 8/8, and each test dropped from
  5-9 s under load to 2-31 ms.
- There is also a latent tier defect. The `vi.doMock` sits inside a support
  module, where the tier regex in `vitest.config.mjs` (which scans only the
  suite's own text) cannot see it. So both suites ran in the shared-registry,
  `isolate: false` `pure` project, doing exactly what that project forbids.
  Deleting `githubClientMock.ts` (its only consumers are these two suites) moves
  them to `kernel`, which is the correct tier.
- `src/test-kernel/desktop/loadSourceModule.ts` is a 61-line file-URL importer
  with a hand-kept type map (6 of its 30 entries already unused). It exists for
  "a fresh module across `vi.resetModules`, built after `vi.mock`". An alias
  import (`await import('@desktop/...')`) gives the same result, as the prototype
  confirmed on `DesktopNavigationPolicy`. There are 28 call sites in 18 suites.
  Exclude the `JsonStore`/`jsonConfigProvider` consumers, which are on the
  retirement boundary, and note that `DesktopCommandSurface` imports the helper
  and never calls it.

**6b. Supply the value through the seam that already exists** (T07; −46 lines
proven over four members).

- `FormTokenClient`, `CodexDeviceLogin` and `DeviceCodeAuth` do
  `vi.stubGlobal('fetch')` and then
  `Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)`. In v4 `Fetch`
  is a `Context.Reference` read per request, so providing the mock directly is
  equivalent and removes the global mutation, its `afterEach` unstubs, and the
  single-consumer `support/fetchTestUtils.stubJsonFetch`.
- `SupabaseAuthProvider` mocks `@auth/pkcePermit` with a hand-built Promise chain
  that turns typed failures into defects. The real permit is an eight-line
  `Semaphore`, so a spy-through
  (`withPkcePermit: vi.fn(actual.withPkcePermit)`) keeps the call count and tests
  the real queueing (20/20).
- `LatexdiffShadowStorage.vitest.ts:36-39` mocks `getConfig` with a hand copy of
  production minus one read. Delete it.
- Leave the `vi.mock('@platform/platform')` members (`ModelAccessSelection`,
  `CliSupabaseAuth`, `ApiProviders`) alone. Swapping them for the fake host keeps
  the ambient `platform()` read, and #12077 §2 assigns that mock to the PR that
  removes the read (#12071).

**6c. Key the subscription coordinator cache by secrets store**
(T14; −46 lines proven: test −19, production −15, knip baseline −12).
`createSecretBackedCoordinator` (`src/auth/oauth/sessionAccess.ts:36-58`) holds
one process-wide coordinator bound to the first `platform().secrets` it saw, so
every suite that reinstalls the platform must call the test seam
`resetCodexCoordinator` (six calls in five suites, zero production callers). A
`WeakMap` keyed by the secrets store makes the stale binding impossible, removes
`reset()`, `resetCodexCoordinator` and its barrel entry, and fixes the same latent
hazard for xAI, which has no reset at all. `src/model/apiProviders.ts` already
caches credentials this way. Production keeps one key, because every host
assigns `Platform.secrets` once, so single-flight refresh is unchanged. This is
not Effect-native in itself. The eventual coordinator service would replace the
`WeakMap` outright. Regenerate the knip baseline through the shrink path.

The fourth issue candidate is §2 above (T04, one bare-runtime builder).

## Refuted in verification

Recorded so the next sweep does not re-raise them.

| Theme                                                                       | Why it was refuted                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests and mocks that cannot fail, or duplicate boundary coverage            | Already done by #12222, #12223 and #12242. What remains is under 15 cosmetic lines.                                                                                                                                                                                                                                                                                                                        |
| Over-mocked internals (latex extraction tools, `AgentCreatorOrchestration`) | Two members were deleted by #12223. The `LatexProcessingHelpers` call-count spy is the regression guard for #7228. The `AgentCreatorOrchestration` mirror is scheduled to change with the helper-call port onto `@texra-ai/llm`, so drop it in that PR.                                                                                                                                                    |
| Test helpers that discard the `Fiber` and poll                              | `ChildRunLoop`'s helper already joins the fiber. The Effect-native rewrite measured net +35 lines. Only 2 of 15 `Effect.runFork` sites run a `.settlement`. A Promise-shaped cleanup (await the completion the helper returns, drop `waitForLiveOwner`) is about −30, outside this lens.                                                                                                                   |
| Let the tester own `Scope` and `Clock`                                      | `SemverUpdateCheck` hand-builds what `it.effect` provides, but the fix is a relabel of about 5 lines, and the nested `Effect.scoped` unwraps are cosmetic. `ArxivProcessor`'s `it.live` is a documented choice, because jittered backoff sits behind real I/O.                                                                                                                                             |
| Cancelling through `AbortController` + `runPromise({ signal })`             | That is how the hosts run these programs (`loginCommands.ts:98-138`, `supabaseAuth.ts:108-133`), including the post-interrupt commit re-await. Moving the tests to `Fiber.interrupt` would stop covering the real edge. Residue: the browser half of `CliSupabaseAuth.vitest.ts:247` settles before its abort and tests nothing.                                                                           |
| Production test seams over module globals                                   | The latch and agent-catalog resets were ruled out by #10675 (closed as not planned). The setup-platform reset belongs to the 2026-09-10 injection proposal. The annotation-budget reset is load-bearing. Note for that proposal: a string-keyed `Context.Reference` for `SharedAnnotationFetchBudget` was prototyped (9/9, production −21 lines) and survives `vi.resetModules`, because lookup is by key. |
| Runners hidden behind `effectRuntime().runPromise` and wrapper aliases      | Converting measured net +10 lines on `LeanTools` (the `it.effect` wrapper outweighs the removed `runPromise`). The largest member was deleted by #12222. AGENTS.md allows `Effect.runPromise` in non-test helpers, and the shims are exactly that.                                                                                                                                                         |
| `it.effect` ceremony around Promise-only subjects                           | **Needs an owner ruling.** The prototype turned `SupabaseAuthProvider` back into plain async tests at −105 lines with identical assertions, and about 60 tests in 7 files share the shape. But it partly reverses #12026, merged four days earlier, and the subjects are Promise facades over `Effect.fn` programs that would shrink the tests anyway once ported.                                         |

## Trailing indicators: test cost that moves only with production

Several survey findings are real test-side costs whose fix is a production
change. Per #12077 §1–2 they are not test work. They are recorded here so the
lane that converts each subsystem deletes the matching test harness in the
same PR.

| Production mechanism                                                                                                                                                                                                                                                                    | Test cost it forces                                                                                                                                                                                                                                                         | Deleted when                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `SessionHandle.schedulePublication`/`settlePublications` keep in-flight publishes as a `Set<Promise>` (`src/agent/runtime/SessionHandle.ts`)                                                                                                                                            | 34 `yield* Effect.promise(() => session.settlePublications())` wrappers across 15 suites, plus about 10 `Effect.tryPromise` wrappers in production callers                                                                                                                  | settle returns an Effect (for example over a `FiberSet`)                     |
| The workflow-script engine runs on `p-queue`/`p-timeout`/`AbortController` (`src/agent/workflowScript/runWorkflowScript.ts`), which the effect-migration ratchet keeps frozen                                                                                                           | About 5.4k lines of Promise harness in `WorkflowScriptEngine`, `WorkflowScriptPersistence` and `WorkflowScriptProgressBridge`: ~30 `vi.waitFor`, ~20 hand-rolled resolvers, 8 fake-timer blocks                                                                             | the engine is ported; this is the largest single test lever found            |
| `ChildRunStrategy.launch/runTurn(ports, signal)` takes an `AbortSignal` (`src/agent/runtime/childRunLoop.ts`)                                                                                                                                                                           | 31 `new AbortController().signal` arguments in `NativeSubagentStrategy` and `WorkflowScriptStrategy`, and 4 tests that only pin signal-to-interrupt bridging                                                                                                                | child runs are cancelled by fiber interruption                               |
| `p-queue`/`p-defer` survive in `packages/cli/src/chat/tui/state/subscribeApprovals.ts` and `packages/cli/src/chat/chatSessionController.ts`                                                                                                                                             | `TuiApprovalRetry` (9 `vi.mock`, 8 `pDefer`, ~25 `vi.waitFor`) and `chatSessionController` (a `PQueue` in `makeInit`, 20+ `pDefer`)                                                                                                                                         | production serializes through Effect, as CLAUDE.md requires                  |
| Module-global registries with no service: `src/agent/index` registry, `platform()`, `@logger/logUtils` (#12075), `UsageLogService` (#12076), `SupabaseClient`, `src/tools/setup/platform.ts` override, `src/skills/runtimeSkills.ts` resolver, `toolAvailability`, `leanServerRegistry` | `vi.mock('@agent/index')` in 15 suites, `vi.mock('@platform/platform')` in 11, `vi.mock('@logger/logUtils')` in 14; per-test `vi.resetModules` + dynamic re-import wherever a latch or cache sits at module scope                                                           | each owner becomes a service provided by a layer                             |
| `RunContext` and `ToolFileInteractionContext` are `AsyncLocalStorage` stores (#12074 B7, #11868; runtime design slices 1-2)                                                                                                                                                             | `vi.mock('@agent/runtime/RunContext')` in 6 suites, `currentSession` in 4, `getCurrentToolContexts` in 3. A verifier removed them from `ClaudeAgentResumeFallback` using the real frame installer (−16 lines), but that ties the tests to a mechanism that is also retiring | `Run`/`ToolCall` services land; the mocks become layer provisions in that PR |
| `RunProgressRendererInit` carries seven injection points that the one production caller never passes (`packages/cli/src/runtime/runProgressRenderer.ts`)                                                                                                                                | `settle()` and `fakeTimers()` harness in `RunProgressRenderer.vitest.ts`                                                                                                                                                                                                    | the heartbeat moves to a `Schedule` in a caller-owned scope                  |

Two method notes for whoever picks up #12077 next:

- #12214 selected suites by "imports `@effect/vitest`" and by the literal
  spelling `Effect.run*`. Both proxies hide work. Four native-llm suites already
  imported `@effect/vitest` before that PR and still carry about 196
  `Effect.run*` calls in plain async bodies. The spelling
  `effectRuntime().runPromise(...)` escaped the grep at 48 sites in 14 files.
  Any follow-up should split per test, not per file, and grep both spellings.
- No suite uses `@effect/vitest`'s `layer(...)` yet. Every shared-layer need is
  met with `Effect.provide` per test.

One thing not to simplify: `support/fetchTestUtils.testHttpClientLayer` routes
`FetchHttpClient.Fetch` through a lambda on purpose. The default
(`() => globalThis.fetch`) is cached once per `Context.Reference`, so the lambda
is what lets the shared process runtime see each test's `fetch` stub.

## What the survey deliberately excluded

- **Subjects on the 1.0 retirement boundary.** The implementation plan's §3
  and §5 rule out Effect conversions inside `KVStore`/`ExecutionKVStore`, the
  persisted graph and `src/agent/node`, file execution leases, application-state
  `JsonStore`, and the old model-handler hierarchy. Their tests retire with
  them. Nine candidates were dropped on this ground. Among them is the
  `ExecutionKVStore` LRU `storeCache`, which its own comment says exists "for
  instance identity (callers spy on the returned store)".
- **Dead exports.** #12084 established that the ratchet's `production-dead`
  bucket is test-only-reachable exports. None were re-surveyed.
- **Pruning useless tests.** #12223 removed 123 files after the survey base, by
  a stricter bar than this survey's. Candidates it had already absorbed were
  refuted in verification rather than re-proposed.
- **`vi.spyOn` as a class**, **TestClock around Promise subjects**, **converting
  pure-function, schema and render suites to `it.effect`**, and **normalizing
  the dual `node:assert`/`expect` idiom**. All four were ruled out before this
  survey, by #12077 or by the owner.
- **Per-file cosmetic edits.** The 2026-08-14 sweep found this exhausted, and
  the survey agents confirmed it: 16 of 36 files in one CLI partition, and 37 of
  40 in the shared/support partition, carry no Effect, timer, mock or harness
  machinery at all.
