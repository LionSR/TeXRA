# 5. Scaffolding: giant suites, local copies of support, option bags and casts

Read at `main` commit `c9ceb23` ("simplify(test): the fake host is a service,
not a module slot (R3-R R6) (#14826)"). Read-only; no suite was run.

Scope: every suite (`src/test-kernel/**`, `packages/*/test/**`,
`packages/llm/test-live/**`, `packages/desktop/tests/e2e/**`,
`supabase/functions/**/*_test.ts`) and the helper modules outside
`src/test-kernel/support/` (`agent/progressTestUtils.ts`,
`agent/output/compileCheckTestUtils.ts`, `cli/fixtures/*`,
`settings/litComponentTestUtils.ts`, `shared/session/fanOutScenario.ts`,
`desktop/*`). `support/` is read only where a suite's local copy duplicates
it.

Open PRs at this commit that touch these suites (REST listing, 2026-11-07):
**#14829** (E, R3-E2) edits `sessionEvents.vitest.ts`, `fanOutScenario.ts`,
`progressTestUtils.ts`, `nativeToolTestLayer.ts`, `testKernel.ts` and
`ApprovalQueue.vitest.ts`. No open PR is B's rename or A's TUI lifecycle at
this commit; the CLI findings (F6) name the TUI suites that PR would touch.

Already found and not repeated: R3-R's R1-R8
(`../2026-11-07-design-red-flags-round-3/R-test-infrastructure.md`), the
11-04 note's C1-C8
(`.agents/docs/proposed/simplification/2026-11-04-store-and-test-support-debts.md`),
K's `cliInitPlatformMock` (`../2026-11-06-design-red-flags-round-2/K-cli.md:383`).
Each is cited where a finding borders it.

## Numbers

| Where                       | Suites | Lines  |
| --------------------------- | ------ | ------ |
| `src/test-kernel` (suites)  | 125    | 19,329 |
| `packages/harness/test`     | 84     | 7,329  |
| `packages/desktop/tests/e2e`| 11     | 3,612  |
| `packages/llm/test`         | 11     | 1,719  |
| `supabase/functions`        | 10     | 860    |
| `packages/texra/test`       | 17     | 591    |
| `packages/llm/test-live`    | 13     | 506    |
| `packages/cli`, `desktop/test`, `extension/test` | 9 | 320 |

Helper share (lines in top-level and `describe`-level declarations: helper
functions, fixture constants, types; imports and test bodies excluded; TS
compiler walk) is 23% over all suites (7,967 of 34,179 lines).

**The five largest suites:**

| Suite                                                  | Lines | Tests | Helper share | Churn (11-01..) |
| ------------------------------------------------------ | ----- | ----- | ------------ | --------------- |
| `src/test-kernel/controllers/session/sessionEvents.vitest.ts` | 1,560 | 14 | 27% (418) | 13 |
| `src/test-kernel/controllers/session/goldenStore.vitest.ts`   | 784   | 8  | 24% (187) | 11 |
| `src/test-kernel/agent/runtime/RetryState.vitest.ts`          | 700   | 10 | 35% (246) | 13 |
| `packages/desktop/tests/e2e/workspaceTabs.spec.ts`            | 649   | 9  | 17% (112) | 1  |
| `packages/llm/test/api/AnthropicMessages.vitest.ts`           | 639   | 7  | 37% (238) | 3  |

Next by helper share among suites of 250+ lines: `LeanServerPool` 51% (a
fake `lake` script: the edge, fine), `ReplyDocuments` 45% (a case table,
fine), `sessionViewUpdate` 43%, `WorkflowRunCommand` 42%, `TuiApprovalRetry`
42%, `ToolUseDispatchParallel` 40%, `ToolUseFollowUp` 39%, `ExecuteCli` 38%.

Primitives in suites: `as unknown as` 22 lines in 17 files (top:
`ToolUseFollowUp` 5); `// cast:` 70 lines (top: `ToolUseFollowUp` 8,
`resumeRun` 5); non-null `!` in the e2e specs 55 (`workspaceTabs` 22),
outside oxlint's `no-non-null-assertion` zone; `Scope.makeUnsafe()` never
closed 4 (`RetryState.vitest.ts:227,284`,
`ToolUseDispatchParallel.vitest.ts:222`,
`SessionExitController.vitest.ts:52`); module-level run-id counters (`let`)
3 suites; `vi.hoisted` mock bags 17 suites, 5 of them CLI suites with 62
`vi.fn` and 23 `vi.mock` between them.

## Findings

### F1. `sessionEvents.vitest.ts` holds four modules' suites, so one module's mocks put all of them in the slow tier

**Flags:** conjoined suite (vague name); change amplification (the
top-churn file).

**Evidence.**

- Four top-level blocks, each a different module:
  `describe('session events and view'` (`:334`), `describe('Sessions owner'`
  (`:389`), `describe('the session event table and its one publisher'`
  (`:467`, 768 lines, the `Database` store), `describe('RunHistory'`
  (`:1235`, 325 lines, 2 tests). 14 tests in 1,560 lines, 111 lines a test.
- The file's `vi.mock`s (`:50-54` SqliteClient, `:112-115` `node:os`,
  `:116-127` the Lean pool) make every case `isolated` (own registry, own
  worker). C7 found the mocks themselves; what is new is that the
  `RunHistory` block (`@shared/session/runHistory`, which has no suite of its
  own) and the framing block need none of them and pay for them.
- Churn: 13 of 106 simplify/refactor commits since 11-01, the most of any
  suite; 7 of `sessionViewUpdate.vitest.ts`'s 8 commits in that window also
  edited this file. Open PR #14829 (E) edits it again.

**The design decision behind it.** Which suite owns a module's cases. The
rule is one suite per module (`src/test-kernel/AGENTS.md`, "Extend the
module's existing suite"); this file is the suite of the session graph, the
store, the owner and the run history at once.

**The better design.** Move the `RunHistory` block to
`src/test-kernel/shared/session/runHistory.vitest.ts` (kernel tier: it needs
`graph([])` and `runHistoryOverStore`, which go with it) together with F2's
shared turn rows. Keep framing, owner and store cases here. No case is added
or deleted; about 330 lines move, and the helpers only that block uses
(`ORIGIN`, `INVOCATION`, `TURN`, `CALLS`, `snapshot`, `refusalOf`,
`approvalRequested`, `toolEnd`, `settled`, `group`, `openTurn`,
`:1236-1436`) leave with it.

**What we give up.** One file to open for "the session's durable boundary".
Risk: none to coverage; the moved cases run in a shared registry, which a
shuffle run should confirm.

**Change amplification.** "A run-history batch rule changes": before, the
file every store and framing change also edits (merge friction with
#14829-sized PRs); after, the run history's own suite.

**Depends on:** sequence after #14829 (E). C7 can land with or after it.

### F2. One tool-use turn's rows, and every run's `run.start`, are restated literally across suites

**Flags:** repetition (fixture rule of three across suites); information
leakage (the run history's write protocol known by each suite).

**Evidence.**

- The same two-call bash turn, with the same literals, in three suites:
  `sessionEvents.vitest.ts:1240-1436` (`ORIGIN`, `INVOCATION` with
  `invocationId: '0f1e2d3c-4b5a-4a9b-8c7d-6e5f4a3b2c1d'`, `RESPONSE_ID =
  '9a8b7c6d-…'`, `TURN` with `call-a`/`call-b`, `CALLS` with
  `lane: 'barrier', replay: 'unsafe', duplicateOf: 'call-a'`, `settled`,
  the tool `group`); `sessionViewUpdate.vitest.ts:131-345` (the same five
  constants, `settlement`, `TOOL_GROUP`, `TURN_ROWS`);
  `ToolUseDispatchParallel.vitest.ts:86-95,210-214,280-300` (`ORIGIN`,
  `INVOCATION`, `RESPONSE_ID`, the attempt and response rows). R1 named the
  last one and `runRecordSeeds.ts`; the first two are new.
- A `run.start` draft is written by hand in 13 suites
  (`grep -c "type: 'run.start'"`: `sessionEvents` 3, `RunProgressRenderer` 3,
  11 more with 1) and in three helpers: `publishTestRunStart`
  (`support/sessionTestUtils.ts:57-73`), `ExecuteCli.vitest.ts:210-217`
  (`runStartRow`), `cli/fixtures/sessionViewFixture.ts:71-77`.
- The cost is measured: #14788 renamed one `run.start` field
  (`followUpSupport` to `takesFollowUps`) and edited 18 test files, 41 added
  lines carrying the new name (`git show 18cecd8 -- src/test-kernel
  packages/*/test`).
- The generic row log the TUI fixture builds views with lives in a scenario
  file: `cli/fixtures/sessionViewFixture.ts:21` imports
  `local, Log, tail, viewOf` from `shared/session/fanOutScenario.ts`, whose
  name is one scenario (`buildScenario`, `fanOutView`, `withProposal`).

**The design decision behind it.** Who owns a fixture row. Inputs written as
literals are right inside one suite ("write the expected output down as a
literal"); the same literal block copied into three suites is the rule of
three, and the shape it copies is the write protocol, which changes with
every run-history PR.

**The better design.** `src/test-kernel/support/sessionRows.ts`: `Log`,
`tail`, `local`, `viewOf` moved from `fanOutScenario.ts` (which keeps its
scenario and imports them), plus three draft builders: `runStart(runId,
over?)`, `toolUseTurn(runId)` (the append, attempt, identified, response and
intent drafts of the two-call turn, with its `RESPONSE_ID`) and
`toolResult(callId, over?)`. `publishTestRunStart`, `runStartRow` and
`sessionEvents.runStart` call `runStart`. Deleted: the three copies of
`ORIGIN`/`INVOCATION`/`RESPONSE_ID`/`TURN`/`CALLS`, `settled` and
`settlement`, about 200 lines; the 13 inline `run.start` literals become
calls where the case does not assert on the literal itself.

**What we give up.** Each suite reading its whole input on one screen.
`sessionViewUpdate` asserts the fold over `TURN_ROWS` commit by commit, so
it keeps its commit-indexed list, built from `toolUseTurn`. Coupling: two
suites now share a fixture, so a fixture change shows in both (which is the
point).

**Change amplification.** "A `run.start` field is renamed": before, 18 files
(measured); after, `sessionRows.ts` and the suites that assert the field.
"A `model.message` response gains a field": before, 3 suites plus
`runRecordSeeds.ts`; after, 1 to 2.

**Depends on:** sequence after #14829 (E), which edits `fanOutScenario.ts`
and `sessionEvents.vitest.ts`. Borders R3 (which proposed `runStart` and
`requestOpened` builders for the TUI fixture and landed the fold-built view
in #14823 without them).

### F3. Three follow-up suites restate the scripted tool-use run, over an option bag with four unused keys

**Flags:** repetition; option bag / speculative generality.

**Evidence.**

- The same composition, three times:
  `ToolUseDispatchInterruption.vitest.ts:44-53` (`loopLayer`),
  `ToolUseProgressEvents.vitest.ts:36-57` (`runScript`),
  `ToolUseWait.vitest.ts:46-66` (`loopProgram`), each
  `Layer.mergeAll(scriptedInvokerLayer, nativeToolTestLayer(…))
  .pipe(Layer.provideMerge(agentRunTestLayer({ ...init, model })),
  Layer.provideMerge(Layer.succeed(RunHistory)(Context.get(init.session,
  RunHistory))))`, and the last two run `openToolUse(…)` then
  `runToolUse(…)` the same way. Each declares its own
  `interface …Init extends Omit<ScriptedRunInit, 'model'>`
  (`:32`, `:31`, `:42`).
- `settledIds` is copied verbatim:
  `ToolUseDispatchInterruption.vitest.ts:38`,
  `ToolUseDispatchParallel.vitest.ts:81`.
- `ScriptedRunInit` (`support/scriptedRunLayers.ts:329-346`) has nine
  fields; `logger`, `finalToolName`, `mediaFiles` and `initialUserMessage`
  are passed by no suite (its only consumers are the three above), and
  `bound` by one case (`ToolUseWait.vitest.ts:312`). `agentRunTestLayer`
  carries a branch for each (`:351-383`), `'initialUserMessage' in init`
  included.

**The design decision behind it.** Where "run this scripted tool-use run"
lives. #14823 moved the model fake into `support/` (R1) but left each suite
to assemble the run.

**The better design.** One export in `scriptedRunLayers.ts`,
`scriptedToolUseRun(init: { runId, session, tools?, script, bound?,
parentRunId?, stopAfterCycle?, resume? })`, returning the run program over
`scriptedInvokerLayer`, `nativeToolTestLayer` and the session's
`RunHistory`, plus `attempts`. Deleted: the three local compositions and
`Init` interfaces, the second `settledIds` (one export beside it), the four
unused `ScriptedRunInit` fields and their branches; about 70 lines.
`agentRunTestLayer` becomes file-local.

**What we give up.** `ToolUseWait` forks its program and reads the log tail
while it waits; it calls the same export inside `Effect.forkChild`, so
nothing is lost. A future case that needs a final tool adds the field back
with its consumer.

**Change amplification.** "The run loop needs one more service":
before, 3 suites; after, `scriptedRunLayers.ts`.

**Depends on:** none (R1 has landed).

### F4. R1 landed without its two largest consumers: `RetryState` and `ToolUseDispatchParallel` keep their own bindings, origins and run builders

**Flags:** repetition (local copy of `support/`); unreleased scopes;
module-level mutable state.

**Evidence.**

- `RetryState.vitest.ts:168-198` `boundModel` and
  `ToolUseDispatchParallel.vitest.ts:164-194` `boundModel` are 30-line
  `BoundModel` literals beside `testBinding`
  (`support/scriptedRunLayers.ts:146-178`), which takes the same overrides.
  R1 counted five hand-built bindings; #14823 deleted `testBoundModel` and
  `RetryState`'s `stubModel` and left these two.
- `ORIGIN` (`openai-responses`, `api.example.test/v1`) is written five
  times: `RetryState.vitest.ts:114`, `ToolUseDispatchParallel.vitest.ts:86`,
  `sessionEvents.vitest.ts:1240`, `sessionViewUpdate.vitest.ts:133`, and the
  unexported `TEST_ORIGIN` (`scriptedRunLayers.ts:56`). `GPT54` twice
  (`:97`, `:78`). `RetryState`'s `completedTurn` (`:147-166`) is `textTurn`
  with usage.
- Each has a run-id counter at module scope (`RetryState.vitest.ts:206`
  `let retryRunCounter`, `ToolUseDispatchParallel.vitest.ts:196`), where
  `startedRun` (`scriptedRunLayers.ts:388`) mints and publishes a run, and a
  local `agentRun` wrapper passing `scope: Scope.makeUnsafe()`
  (`RetryState.vitest.ts:227`, `ToolUseDispatchParallel.vitest.ts:222`),
  never closed; `RetryState.vitest.ts:284` opens a third for the
  `ScopedRef`. `agentRunTestLayer` takes `yield* Effect.scope` instead
  (`scriptedRunLayers.ts:357`).
- `RetryState.vitest.ts:100` restates `RETRY_BACKOFF_MS = 1000` from
  `ModelRetryGate.ts:16` (unexported), with a comment naming the source.
- Churn: 13 and 10 (11 and 10 by `git log` on each path).

**The design decision behind it.** Whether a suite that needs one more knob
of the shared fake extends it or copies it.

**The better design.** `testBinding(model, { modelId, backend, origin, … })`
and an exported `TEST_ORIGIN`; `startedRun(session)` for ids;
`agentRunTestLayer` (or F3's export) for the run, in the test's scope.
`RetryState`'s `openRun` keeps only what differs: the real
`modelAccessLayer` it reads `credentialSwitch` from (whether any case needs
the real one rather than `scriptedInvokerLayer`'s `null` is unverified; run
the suite with the swap to decide). Deleted: two `boundModel`, four `ORIGIN`
copies (the two in F2's suites go with F2), two `GPT54`, `completedTurn`, two
counters, two `agentRun` wrappers, three unclosed scopes; about 120 lines.

**What we give up.** The OpenAI-shaped binding: the cases do not branch on
the backend (unverified for `RetryState`'s route policy key
`['openai', 'api-key', …]`; keep it as an override if the gate keys on it).

**Change amplification.** "`BoundModel` gains a required field": before, 3
files; after, 1.

**Depends on:** F3 for the run builder; otherwise none.

### F5. `ToolUseFollowUp.vitest.ts` builds a second session log and a session context out of casts

**Flags:** a fake that is a second implementation of its port; casts
reaching past a type; mocks of repository modules; module-level mutable
state.

**Evidence.**

- `recordedFollowUps` (`:80-164`) is an in-memory `SessionLog`: its own
  `seq`/`commit` numbering (`:99-107`), `transact`, `runRows` over
  `foldRunRows`, `history`, `records`, `hold`, `settled`, under
  `} as InboxPort['log']` (`:142`), with a `failWrites` counter for write
  faults.
- `fakeSession` (`:185-226`) assembles `Runs`, `SessionViewAccess`,
  `SessionLog` and `Interactions` with five `as unknown as`
  (`:197,201,214,222,224`); 8 `// cast:` lines, the most of any suite.
- It spies two repository modules (`:187-193`,
  `vi.spyOn(resumability, 'checkpointRefusal')`,
  `vi.spyOn(resumeRunModule, 'resumeRun')`) and steers them through two
  module-level `let`s (`:58` `tryResume`, `:176` `recorded`), plus a
  `setTimeout(0)` `settle` (`:41`; lens 4).
- `support/` already serves the real thing: `isolatedTestSession()`
  (`testKernel.ts`) over the ephemeral store has the log, the registry and
  the view; `storeFaults.sessionStoreFaults` fails or holds the next matching
  write and undoes itself (R3-R "Good modules").

**The design decision behind it.** What a follow-up's admission is tested
against. The suite tests `submitFollowUp` against its own model of the log,
so a log rule (commit numbering, `settled`, the publisher serializing jobs)
the real store changes is invisible here.

**The better design.** Run the cases over `isolatedTestSession()`; seed
`live` with `holdTestRun`, the `idle` case with `publishTestRunStart`, write
faults with `sessionStoreFaults`; answer the resume through the session's
real resume path or, where a case needs a fixed answer, a `Layer.mock` of the
one service it reads. Deleted: `recordedFollowUps`, `fakeSession`, the two
spies, the two `let`s, five `as unknown as`; about 150 lines.

**What we give up.** The `failWrites: n` budget (a counter) becomes one
fault per `sessionStoreFaults` scope; the suite runs a real store, slower per
case (kernel tier either way).

**Change amplification.** "`SessionLog` gains a member a follow-up reads":
before, the port and this fake (and the cast hides a missing member until a
case calls it); after, the port.

**Depends on:** none.

### F6. The CLI suites build their platform four ways: mock bags, a wrapped session, a cast platform, and single-consumer context presets

**Flags:** repetition; casts reaching past a type; single-consumer helpers;
option-bag presets.

**Evidence.**

- Mock bags: `chatSessionController.vitest.ts:18` (21 `vi.fn`, 4
  `vi.mock`), `ExecuteCli.vitest.ts:51-65` (15, 5),
  `SessionExitController.vitest.ts` (13, 4), `WorkflowRunCommand.vitest.ts:47`
  (8, 6), `TuiApprovalRetry.vitest.ts:10` (5, 4). `@cli/runtime/platform/logSinks`
  is mocked in three of them, `cliPresentationHost`, `cliContext`,
  `cliProcessRuntime` and `initPlatform` in two each (K found the last).
- `ExecuteCli.vitest.ts:92-128` `runSessionFake` spreads the real
  `LocalSession` and replaces `start` with a Promise mock (`mocks.admit`,
  `mocks.rootLaunch`, cast at `:107`) and `request` under a cast (`:121`);
  `stubHangingRun` (`:226-249`) chains `Effect.runPromise(...)` with
  `.then(` and restates `run.start` (`runStartRow`, `:210`).
- `CliPlatformServices` is cast twice with different members:
  `ResumeCommand.vitest.ts:119-124` (`runtime`, `session`, `runSession`,
  `service`) and `WorkflowRunCommand.vitest.ts:144-148` (`...platform`,
  `session`, `runtime`).
- `cli/fixtures/cliContext.ts` exports two presets with one consumer each:
  `createRunCommandCliContext` (`:55`, `WorkflowRunCommand` only, one key)
  and `createTuiCliContext` (`:65`, `TuiApprovalRetry` only, though its doc
  says "suites'"). Meanwhile `ResumeCommand.vitest.ts:97-107` and
  `chatSessionController.vitest.ts:160-172` restate the same interactive
  preset (`mode: 'interactive'`, `approvalPolicy: 'ask'`, four TTY and
  color keys) locally, and `SlashCommandDispatch.vitest.ts:60` a third.
- Churn: `ExecuteCli` 10, `chatSessionController` 9, `TuiApprovalRetry` 9.

**The design decision behind it.** What a CLI command test runs over. The
command reads `CliPlatform`; each suite decides which members are real and
casts the rest.

**The better design.** In `cli/fixtures/`: `testCliPlatform(session)`, a
`Layer` serving `CliPlatform` from the test's session and graph with every
member the commands read (2 consumers now, `ExecuteCli` a third once its
`start` stub becomes a scripted model run). One `interactiveCliContext`
preset replacing `createTuiCliContext` and the three local copies; delete
`createRunCommandCliContext` (inline its one key). Deleted: two casts, two
presets, three local presets, about 60 lines. The mock bags shrink with
each mocked module that gets a port (lens 2's subject, not counted here).

**What we give up.** Per-suite visibility of exactly which members a command
reads (the cast said so); a member the shared platform serves that a command
should not read no longer fails loudly unless the platform is a
`Layer.mock`, which it should be.

**Change amplification.** "`CliPlatformServices` gains a member a command
reads": before, each cast suite fails only at runtime in the case that reads
it; after, `testCliPlatform`.

**Depends on:** sequence the TUI suites (`chatSessionController`,
`SessionExitController`, `TuiApprovalRetry`) with A's TUI lifecycle PR when
it opens (none at this commit).

### F7. Every e2e test writes the app's lifetime by hand, and the e2e tree sits outside the `!` lint rule

**Flags:** repetition (rule of three in one file); state in optional
fields; casts (`!`) reaching past a type.

**Evidence.**

- 25 `launchTexraApp(` sites across the specs and 21 `try { … } finally {
  closeTexraApp(…); cleanupDirectory(…) }` blocks (`agentCatalog` 3,
  `stateStoreStartup` 2, `sessionLifecycle`, `serviceClient`, `devStartup`,
  `menuLifetime`, `screenshots`, `trajectories`, `workspaceTabs`).
  `agentCatalog.spec.ts:32-97,108-186,200-247` repeats the whole block three
  times: `createIsolatedProfile()`, `let launched`, `const errors = []`,
  `page.on('pageerror', …)`, `expect(errors).toEqual([])`, `finally` with
  one close and two cleanups.
- `pageerror` collection is written 5 times in 3 specs
  (`agentCatalog.spec.ts:37,113,207`, `devStartup.spec.ts:47`,
  `workspaceTabs.spec.ts:148`), while `launchTexraApp` already subscribes
  to it to log (`electronApp.ts:138`).
- `LaunchedApp.ownsWorkspace` / `ownsUserData` (`electronApp.ts:186-187`,
  read in `closeTexraApp`, `:192-200`) carry ownership as two booleans
  because the launch does not own its own teardown.
- 55 non-null `!` in the specs (`workspaceTabs` 22, including 16
  `(await x.boundingBox())!`). `oxlint.config.mts:348` applies
  `typescript/no-non-null-assertion` to `src/test-kernel/**` and
  `packages/*/test/**`; `packages/desktop/tests/**` is in neither.
- Churn is low (1 each), so the cost is size and each new spec's learning,
  not merge friction.

**The design decision behind it.** Who owns an app's lifetime in a spec.
Playwright's fixtures (`test.extend`) are the runner's own scope: set up
before the test, torn down after it, whatever the outcome.

**The better design.** `electronApp.ts` exports `test =
base.extend<{ launched: LaunchedApp }>({ launched: async ({}, use) => { … }
})`: the profile, the launch, a renderer-error list asserted empty after
`use`, then close and cleanup. A spec that needs its own paths or env uses
`test.use({ launchOptions })`. A `box(locator)` helper asserts a bounding box
with `expect` instead of `!`. Widen the lint zone to
`packages/*/tests/**`. Deleted: about 21 `try/finally` blocks, 5 error
collectors, `ownsWorkspace`/`ownsUserData`, 55 `!`; about 180 lines.

**What we give up.** Specs that relaunch within one test
(`stateStoreStartup`, `sessionLifecycle`) keep an explicit second launch;
the fixture covers the first. Risk: a spec that tolerates renderer errors
needs to say so (none does today: every collector asserts `[]`).

**Change amplification.** "Every launch also checks X at teardown": before,
21 blocks; after, the fixture.

**Depends on:** none.

### F8. Two edge-function suites patch `Deno.serve` because their handlers serve on import

**Flags:** code shape forcing a global patch (the fix is in production);
repetition; casts.

**Evidence.**

- `auth-device/approvalRequest_test.ts:52-91` and
  `log-usage/usageOwner_test.ts:52-75` hold the same block: save
  `Deno.serve`, replace it under
  `}) as unknown as typeof Deno.serve;` (`:77`, `:62`, the only two casts in
  `supabase/`), `await import('./index.ts')`, call the captured handler,
  restore in `finally`. Both also replace `globalThis.fetch`
  (`approvalRequest_test.ts:56`, `usageOwner_test.ts:13-24`).
- The cause is production: `auth-device/index.ts:444` runs
  `Deno.serve(app.fetch);` at module scope, and
  `_shared/logUsage.ts:83-92` `serveLogUsage` calls `Deno.serve` itself.
  The other two functions already export the handler and serve only as the
  entry: `auth-bridge/index.ts:106` (`export function handleRequest`) and
  `:148` (`if (import.meta.main) Deno.serve(handleRequest)`);
  `github-app-token-exchange/index.ts:51,129-131`. Their suites import the
  handler and patch nothing (`auth-bridge/index_test.ts:3`,
  `github-app-token-exchange/index_test.ts:4`).

**The design decision behind it.** Whether an edge function's module is its
handler or its server. Two of four decided "handler"; two did not.

**The better design.** `auth-device/index.ts` exports `app` and serves under
`import.meta.main`; `serveLogUsage` becomes `logUsageHandler(...)` returning
the handler, and `log-usage/index.ts` and `log-usage-v2/index.ts` serve it
under `import.meta.main`. The two suites call the handler. Deleted: two
capture blocks and two casts (about 20 lines). The `globalThis.fetch`
patches stay until the edge clients (`_shared/edgeClients.ts:28,35`, module
level `createClient`) take their `fetch`; that is a further step, not
proposed here.

**What we give up.** Nothing; the deployed entry still serves.

**Change amplification.** "A new edge-function test of `index.ts`":
before, copy the capture block; after, import the handler.

**Depends on:** none. Round 4's package F (#14822) last edited these
functions; nothing there changes this.

### F9. Smaller items, batched

None depends on a root.

- **A one-package llm suite in the cross-package tree, reaching into
  `src/`.** `src/test-kernel/llm/GoogleInteractions.vitest.ts:14` imports
  `'../../../packages/llm/src/api/googleInteractions.js'`; its siblings live
  in `packages/llm/test/api/` and import `../../src/api/…`. Move it there
  (one file, the import shortens). The three SSE `response(...)` builders
  (`AnthropicMessages.vitest.ts:169`, `OpenaiResponses.vitest.ts:113-128`,
  `GoogleInteractions.vitest.ts:42`) differ in framing (`event:` lines,
  `sequence_number`), so they stay local.
- **`agent/progressTestUtils.ts`, a 219-line helper outside `support/`,
  imported by relative path from 10 suites.** `seedActiveRun` (`:182-193`)
  is an `async` function over three `Effect.runPromise` whose one consumer
  wraps it back in `Effect.promise` five times
  (`RetryState.vitest.ts:411,468,515,544,577`); make it an Effect.
  `recordSessionEvents` (1 consumer) and `bashApprovalRequest` (1 consumer)
  inline into their suites; the rest (`decideRequest`, `autoDecideRequests`,
  `createRecordingHost`, `commandTool`, 2 to 7 consumers) moves to
  `support/` under a name for what it holds (`requestFixtures.ts`).
  Sequence after #14829, which edits it.
- **Single-consumer shared helpers.** `settings/litComponentTestUtils.ts`
  (202 lines) has one consumer, `progressView/BashRequestPanel.vitest.ts`;
  `cli/fixtures/cliContext.ts`'s two presets (F6);
  `storeFaults.parkedRoot` (`:562`) and `compileCheckTestUtils.runDir`
  (`:29`) are exported with no outside consumer. Un-export the last two;
  leave `litComponentTestUtils` where a second Lit suite would find it, or
  move it beside its one consumer.
- **A helper restating the storage layout.**
  `compileCheckTestUtils.ts:29-44` (`runDir`, `runStorageFile`) builds
  `path.join(roots.storage, 'executions', runId)` and its location by hand;
  `runDirUnder` and `runStorageAbsolutePathUnder`
  (`common/storage/storageLayout.ts:66,94`) are the production owners.
  Setup should call them (an expected path in an assertion may stay a
  literal).

## Good suites worth copying

- `packages/llm/test-live/*.live.ts` over `support.ts`'s `liveProtocol`
  (`:240`): each route is a 10-14 line spec (key, model, endpoint,
  continuation), one suite per route as `src/test-kernel/AGENTS.md`
  requires, all behaviour in one helper.
- `packages/harness/test/agent/followUp/ToolUseWait.vitest.ts`'s `forkLoop`
  (`:68-90`): it waits for the run's `n`-th `waiting` row on the log's tail,
  a published signal, and runs the production loop over the shared scripted
  model.
- `supabase/functions/auth-bridge/index_test.ts` and
  `github-app-token-exchange/index_test.ts`: they import the exported handler
  and patch nothing (the shape F8 asks of the other two).
- `src/test-kernel/agent/output/ReplyDocuments.vitest.ts`: a high helper share
  (45%) that is a case table (`RECOVERY_CASES`, `:101`) driven by one
  `it.effect.each`; data, not scaffolding.
- `src/test-kernel/tools/lean/LeanServerPool.vitest.ts`: its 51% helper share
  is a fake `lake` process at the real edge (`:36-124`) under the production
  spawner.
- `cli/fixtures/sessionViewFixture.ts` after #14823: views are the fold's
  output from rows (it needs F2's builders, not a redesign).

## Already settled, left alone

- `sessionEvents`'s and `goldenStore`'s copies of `sessionGraphLayer`, their
  raw `event.data` reads, their mocks, internal pins and `killedHost`: C2,
  C3, C5, C6, C7 (11-04 note). The raw reads also account for 11 of the 70
  `// cast:` lines (`resumeRun.vitest.ts:91,103,110,225`,
  `AgentLaunchActivation.vitest.ts:50-64`, `hooks.vitest.ts:55-177`); they
  go with C3.
- The six scripted models, `receiptModel` (`resumeRun.vitest.ts:343`),
  `countedModel` (`goldenStore.vitest.ts:688`), `observingInvokerLayer`
  (`RunScopedToolOverlay.vitest.ts:70`): R1 and R5. F4 reports only what
  #14823 left of R1 in two suites.
- `nativeToolTestLayer`'s option set and request copy: R2 (landed).
- The e2e `postMessage` drivers, `dismissOnboarding`'s swallowed wait and the
  raw-SQL store reads: R3-R R8.
- `chatSessionController`'s two `Scope.makeUnsafe()`
  (`:180-181`): closed by `onTestFinished` (`:182-188`); not a leak.
- `vscode-mock.ts` and `desktop/electronTestStub.ts`: module aliases
  (`vitest.config.mjs:171,174`), so their exports have no importers by
  design.
- `litComponentTestUtils.ts` installing DOM globals: the Lit suite brings its
  own DOM, which `src/test-kernel/AGENTS.md` "Test tiers" (`isolated`)
  allows.
- The twelve one-call live suites as one table file: refused; the guide
  requires one suite per route (`src/test-kernel/AGENTS.md`, "Test tiers").
- The three provider SSE builders: different framings (F9), not one helper.
