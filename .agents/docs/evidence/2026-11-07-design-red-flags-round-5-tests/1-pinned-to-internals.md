# 1. Suites pinned to internals (round 5, lens 1)

Read at `main` commit `c9ceb23` (`simplify(test): the fake host is a service,
not a module slot (R3-R R6) (#14826)`). Read-only.

Question: which suites import deep modules or assert intermediate shapes,
where an outcome at a stable boundary would do? The stable boundaries named
below are: the session's view and rows, a host verb (`session.start`,
`session.request`, `runCli(argv)`), a tool's result, the CLI's exit code and
output streams, and what an E2E user sees.

Open PRs at `c9ceb23`: #14815 (`AgentCliSessionStores` only), #14828 (docs),
#14773 (docs). None touches a suite named here. Round 4 says no PR is open
for A's K4 follow-up (F1, F5, K5: the CLI's run claim, exit code and exit
window) or for E's R3-E2 (the storage-format batch). Each finding below says
which of those two owners has to sequence it.

## Numbers

- **Churn method.** I counted commits since 2026-11-01 whose subject starts
  with `simplify` or `refactor`. That gives 49 commits, against the
  orchestrator's 106, so my per-file counts run lower: `sessionEvents` 10
  against 13, `RetryState` 10 against 13. Where the BRIEF lists a file, I
  quote the BRIEF's number. Other files carry my own count, marked "(r)".
- **`vi.mock` is a CLI habit.** 22 files use `vi.mock` / `vi.doMock`, and 11
  of them are under `src/test-kernel/cli/`. That makes 37 mock factories over
  26 distinct modules, 23 of them the CLI's own (`grep -hoE
  "vi\.(mock|doMock)\('[^']+'" src/test-kernel/cli/*.ts`). The worst files:
  `WorkflowRunCommand` 6, `ExecuteCli` 5, `chatSessionController` 4,
  `TuiApprovalRetry` 4, `SessionExitController` 4. `packages/*/test` has 1.
- **The internal session handle.** 28 suites reach the internal
  `Context<SessionServices>` from a public `LocalSession` through
  `sessionHandleOf` (`support/testKernel.ts:361`). Suites then read the
  internal services directly: `Approvals` in 6 suites, `Runs` in 8, `Inbox`
  in 6, `RunHistory` in 8, and `SessionLog` 81 times. This is the
  `SessionHandle (28)` seam of the 10-27 note (§4 A1). It is cited here, not
  re-reported.
- **Module-namespace spies.** 6 sites in 4 suites stub a repository function
  through its module namespace: `vi.spyOn(execUtils, 'executeCommand')` ×4,
  `resumeRun` ×2, `checkpointRefusal`, `wakeIfOwed`.
- **Relative cross-package imports.** 7 imports in 6 suites reach another
  package's `src/` by relative path. An example is `RetryState.vitest.ts:87`:
  `from '../../../../packages/llm/src/api/verdict.js'`.
- **One rename's blast radius.** One row-field rename (`followUpSupport` to
  `takesFollowUps`, #14788 `18cecd8`) edited 20 test files and the golden
  fixture. Of the 20, 12 suites write a `type: 'run.start'` literal by hand
  (finding 1.4).
- **Package suites are quiet.** The `packages/llm`, `packages/texra`,
  `packages/extension`, `packages/desktop/test` and `supabase/functions`
  suites are low-churn (≤ 2 (r) each) and test at their boundaries (see
  "Good suites").

## Findings, ranked by churn

### 1.1 The run-loop suites build the run's middle by hand and drive internal entry points with option bags

**Files and churn:** `RetryState.vitest.ts` (700 lines, churn 13),
`ToolUseDispatchParallel.vitest.ts` (584 lines, churn 11).

**Flags:** information leakage (the invoker's write protocol and the
dispatch's options, restated in the suites), a shallow test interface (an
option bag per call), two representations (each suite's own `BoundModel`
beside `testBinding`).

**Evidence.**

- **`ToolUseDispatchParallel`** opens the run by writing the invoker's rows
  itself. Its `openDispatch` says so: "commit the completed turn the
  dispatch continues from, exactly as `ModelInvoker` does" (`:264`).
  - It writes `request: '0'.repeat(64)` (`:290`) and the response's
    `calls: dispatchFactsFor(localCallsOf(turn.content), tools, noopTrace)`
    (`:303`).
  - It then calls the loop's internal step directly, with a seven-key bag
    (`:330-338`):
    `dispatchPendingResponse(kit.cell, { definitions, registry: kit.tools,
    offered: [], services: Context.empty(), stepRoots: [], hooks:
    stepHooks(run, new Map(), null), modules: {} })`.
  - Its `boundModel()` (`:164-197`) is an inert 30-line `BoundModel`
    literal.
- **`RetryState`** keeps its own 30-line `boundModel` (`:168`).
  - Its `openRun` (`:254-322`) hand-composes `modelInvokerLayer()`
    (`:307`), a re-served `ModelAccess` and
    `Layer.sync(RouteRetries, makeRetryGate)` (`:317`). That is
    `scriptedInvokerLayer` (`scriptedRunLayers.ts:233`) written out a second
    time.
  - It asserts on `RunState` internals:
    `outcome.state.invocation?.current.failed?.next.kind` should be `'ask'`
    (`:475`), and `state.invocation?.current.accepted` (`:676`).
  - It pre-judges failures through the llm package's internal verdict
    (`judgeFailure`, `:87`, `:339`).
- **What the churn edited.** These are the lines the churn edits. For
  `RetryState` (`git log -p`): the route gained `endpoint` (#14785); the
  binding cell went from `SynchronizedRef` to `ScopedRef`, and
  `ModelRetryGate` moved (#14781, #14778); `automaticRetries` was re-derived
  from the setting (#14818); the setting moved from `.configKey` to the
  setting object (#14818); `delivery` was dropped (#14801); and the FakeHost
  roots changed (#14826). `ToolUseDispatchParallel` took the same route,
  `ScopedRef`, `automaticRetries` and `delivery` edits. It took the
  dispatch-option edit too (#14788, `stepHooks`), and `purpose` was dropped
  (#14778). None of these edits changed what a test asserts.
- **Borders R1.** This is the residue of round 3's R1
  (`R-test-infrastructure.md:102`). R1's fix listed "`RetryState`'s local
  `stubModel`/`boundModel`/composition, `ToolUseDispatchParallel`'s inert
  `boundModel`" as deleted. #14823 deleted `stubModel`. It kept both
  `boundModel`s, `openRun`'s composition and the hand-written rows.

**The design decision behind it.** Where a run-loop suite enters the loop.
These two enter between write points: after the invoker's rows and before
the dispatch. The suite therefore restates both the rows that come before
its entry and the arguments the loop passes at it.

**The better design.** Name the boundary, then what a replacement asserts
there.

- **`ToolUseDispatchParallel`.** Run the tool-use loop the way the three
  follow-up suites do (`ToolUseWait.vitest.ts:50`, `runToolUse` over
  `agentRunTestLayer`), with
  `scriptedModel([toolCallTurn(calls), textTurn('done')])`. Assert what the
  suite already asserts, on `SessionLog.runRows(…, 'results')`, the
  folded `edited` / `toolCalls`, and the `tool.start` / `tool.end` counts.
  - Those assertions are good and stay. Only the entry changes.
  - `toolCallTurn` writes `argumentsText: '{}'`
    (`scriptedRunLayers.ts:220`). It needs a call's `input` as a field: one
    line of data, not an option.
- **`RetryState`.** Keep `ModelInvoker.invoke` as the entry: it is the
  harness's documented boundary for every model call. Build the run with
  `testBinding(model, { modelId, catalogEntry, automaticRetries })` and
  `scriptedInvokerLayer`. Then replace the two `RunState.invocation` reads
  with the rows a resume reads:
  - the `model.message` `failed` row's `next`;
  - the `request.opened` row, which is already asserted (`:418-425`);
  - the run's position in the view, which is already asserted.
- **Deleted:** two `boundModel` literals (about 60 lines), `openRun`'s layer
  composition (about 40 lines), `openDispatch`'s hand-written attempt and
  response rows (about 35 lines), `freshState` ×2, `ORIGIN` ×2, and the
  `judgeFailure` deep import. The scripted `ModelError` takes the kind the
  binding would give it.

**What we give up.** The parallel suite drives one dispatch with no turn
around it. A real loop also runs `prepareTurn` and a second turn, which adds
rows to the history but is cheap (R1's own estimate). The failure path in
`RetryState` stops being written against the `RunState` field names. That
is the point, but the `next.kind === 'ask'` check becomes a check on the
row's payload.

**Change amplification.** One change: "`BoundModel` gains a field". Before:
`ModelAccess.ts`, `testBinding`, `RetryState`, `ToolUseDispatchParallel`
and `pricing.vitest.ts` (`:46`, `:127`), which makes 5 files. After: 2.

**Depends on.** None. Sequence with **E's R3-E2**, which stores the verdict
row: the `failed.next` assertion (`:475`) moves to the row that batch
defines.

### 1.2 The headless CLI command suites stub the launch, mock the CLI's own modules, and seed the rows the real launch writes

**Files and churn:** `src/test-kernel/cli/ExecuteCli.vitest.ts` (409 lines,
churn 10), `ResumeCommand.vitest.ts` (185, 8 (r)), `WorkflowRunCommand.vitest.ts`
(361, 6 (r)).

**Flags:** a fake that is a second implementation (of the session's
`start`), repetition of production logic in a mock, information leakage
(the command's module layout is the test's seam).

**Evidence.**

- **`ExecuteCli`.**
  - **Five mocked CLI modules:** `cliPresentationHost`, `approvalAdapter`,
    `sessionProgressSubscription`, `scriptPlainOutput` and `logSinks`
    (`:125-152`).
  - **A hand-built session.** `runSessionFake` (`:92-123`) replaces
    `session.start` with a hand-built `Run` (`view: Stream.empty`,
    `events: Stream.empty`, `:109`), whose result is a `vi.fn`.
  - **Seeded rows.** Because no launch runs, the stub commits the
    `run.start` row the launch would have written (`:237`).
  - **The first test.** It observes its outcome by calling the harness's
    internal `liveToolGates(...)` from inside the stub (`:319`).
  - **The second test.** It asserts a mock's call
    (`toHaveBeenCalledExactlyOnceWith({ kind: 'run.stop', … })`, `:379`).
    It times the shutdown with `shutdown.addObserver` (`:389`) and a
    `setTimeout(0)` `settle`.
- **`WorkflowRunCommand`.**
  - **Six mocks:** `storageLayout`, `runModel`, `_helpers/output`,
    `agents`, `executeCli` and `workflowInputs` (`:57-110`), for one test
    (`:321`).
  - **A copied, drifted mock.** The `workflowInputs` mock copies
    `hasMixedStdinWorkflowInputSpecs` (`:98-103`, the same body as
    `workflowInputs.ts:87-94`) and two constants. One constant has already
    drifted: the mock says `'At least one workflow input file is
    required.'`, and production says `'At least one input file is required
    for a document task.'` (`workflowInputs.ts:30-31`).
  - **A hand-built platform.** The platform is built by hand and cast
    (`as unknown as CliPlatformServices`, `:148`).
  - **Seeded rows.** The test seeds the `run.start` and the documents
    `plugin.fact` that the mocked `executeCliConfig` would have committed
    (`seedStartedRun`, `:254`).
  - **A pinned path.** It asserts `runDirectory: '/tmp/runs/abc00a'`, a
    path its own `runDirUnder` mock invented (`:60`, `:352`).
- **`ResumeCommand`.** The same cast platform (`:124`). It mocks
  `cliService` and `logSinks` and asserts that
  `writeTextStderr` was called with the message (`:178`).
- **The K4 rewrite.** K4 + K11 (#14820) rewrote 14 CLI suites, for 380
  changed lines (ResumeCommand 121, WorkflowRunCommand 46, ExecuteCli 29),
  without changing one assertion's intent. Round 2's
  `K-cli.md:397` predicted it ("six test files pin the memo"), and
  `F-hosts.md:493` named `ExecuteCli` and `WorkflowRunCommand` as pinning
  the shape.

**The design decision behind it.** What a CLI command suite runs over. Its
users see an exit code, stdout and stderr, and a run in the store. These
suites replace everything between argv and the store, so they test the
command's internal call graph.

**The better design.** The boundary is `runCli(argv)` (`commands/root.ts:160`,
which returns `{ exitCode }`). Run it with the output streams captured by
`spyOnStreamWrite` (`cli/fixtures/streamWriteSpy`, used by
`OverleafCloneCommand`), over `validationHost` (`storeFaults.ts:401`: a real
store, the validation model at the provider edge, the golden and echo
agents). The replacement asserts:

- **Headless `never` / `ask` runs** (`ExecuteCli` `:331`): the run's
  `tools.offered` row omits the approval-gated tools. That is the observable
  effect of `approvalPromptsUnavailable`
  (`agentToolResolution.ts:176-181`). `resumeRun.vitest.ts`'s
  `offeredTools` reads the row today. Replace its raw `JSON.parse` with the
  decoded reader, per C3.
- **Shutdown** (`ExecuteCli` `:349`): an agent that says "Hold this turn."
  (`validationModel.ts:207`), the shutdown scope closed, the stored `run.end`
  outcome `cancelled`, and exit code 130.
- **Workflow `--output` on a failed run:** the target file is unchanged,
  the JSON on stdout names the failed outcome and the run-storage output,
  and the path is under the host's own storage. A failed document run needs
  a scripted `ModelError`. Whether the validation model can fail a document
  task is unverified.
- **Resume of an ended one-shot:** exit code 2 (`Usage`) and the
  `--fork` hint on stderr.
- **Deleted:** 13 `vi.mock` factories, `runSessionFake`,
  `stubHangingRun`, `stubExecuteCliDeps`, `mockWorkflowRun`,
  `seedStartedRun`, the copied `hasMixedStdinWorkflowInputSpecs`, and two
  `as unknown as CliPlatformServices`. That is about 600 of the 955 lines.
  It also moves the three suites from `isolated` to `kernel`.

**What we give up.** The exact interleaving checks in the shutdown test: the
`recoveryWrite` latch, and "shutdown waits for the finalizer" proven with
`addObserver`. A held validation run shows that the outcome is stored before
exit, not the order of two internal callbacks. The real path also costs
about one real model-free run per case (`REAL_RUN_TIMEOUT` suites already do
this). Whether `runCli` runs a session in-process under the vitest home
isolation is unverified. If it cannot, the boundary is
`executeCliConfig` over the real `LocalSession`, which drops only the
`runSessionFake` and the five mocks.

**Change amplification.** One change: "the CLI's platform gains a service"
(K4's kind). Before: the platform and the 3 cast fixtures. After: the
platform. A second change, "a run-start field is renamed": before, also
`ExecuteCli:237` and `WorkflowRunCommand:254`; after, neither.

**Depends on.** **A's K4 follow-up** (F1 + F5 + K5). It replaces
`shutdownFinalizationDone` and `onInterruptedRunFinalized`
(`executeCli.ts:81`, `:288`), which the shutdown test pins. Write the
replacement in that PR, against the exit code and the stored outcome.

### 1.3 The chat TUI suites assert the controller's own run claim and module signals, over a session made of `vi.fn`s

**Files and churn:** `src/test-kernel/cli/chatSessionController.vitest.ts`
(509 lines, churn 9), `TuiApprovalRetry.vitest.ts` (353, churn 9),
`SessionExitController.vitest.ts` (95, 3 (r)).

**Flags:** state machine in optional fields (`runId`, `runSettled`,
`exitCode` and `runCompleted` as the test's oracle), assertions on a mock's
calls, information leakage (module-level signals read by the test).

**Evidence.**

- **`chatSessionController`.**
  - **Four mocked modules** (`:40-58`): `initPlatform`,
    `cliPresentationHost`, `subscribeApprovals`, and the whole TUI
    `transcript` module.
  - **A session of mocks.** The session's verbs are mocks (`request:
    mocks.request, start: mocks.rootLaunch, resume: mocks.resumeRun`,
    `:252-254`).
  - **What it asserts:** the claim record's fields (`session.runId`, polled
    with `vi.waitFor`, `:383`, `:433`; `session.exitCode`, `:399`, `:441`);
    the `runStopFacts` signal (`:389-390`); `chatTuiCanStartRootRun(session)`
    (`:501`); and `mocks.executeAgent` not called (`:504`).
  - **Already queued for deletion.** These fields are F1's
    `RootRunClaim` / `sessionRunState.ts`, which round 1 (`F-hosts.md:140-146`)
    and round 4 assign to A to delete.
- **`TuiApprovalRetry`.**
  - **Four mocks** (`:16-44`), one of which replaces
    `SubscriptionPreference.get` inside the real module.
  - **A call count as the oracle.** The own-key check is counted as reads
    of `secrets.get` (`openAiKeyChecks`, `:274`; `toBe(1)`, `:349`).
  - **A mock call as the oracle.** "The preference is not rewritten" is
    `setCliSubscriptionPreference` not called (`:346`).
  - **Internal state.** The bash grant is read from the internal
    `Approvals.bypass(runId, 'bash')` (`:316`). The modal is the module
    signal `currentApproval` (`:227`, `:249`).
- **`SessionExitController`.** It mocks `cliContext`, `initPlatform`,
  `logSinks` and `terminalCleanup` (`:17-31`) for one test.

**The design decision behind it.** Which state a chat test reads. The
chat's contract is what the person sees, the exit code, and what the session
records. The suites read the controller's bookkeeping instead, which is the
part A's PR replaces.

**The better design.** Use a real `TestSession` over `validationHost`.
Drive it through the controller's public verbs (`submit`, `resume`, `stop`),
and assert the session and the process. The replacements:

| Case | Assert |
| --- | --- |
| Ctrl-C during resume | the run's view `outcome: 'cancelled'` and exit code 130 |
| Failure while leaving | exit code `AgentError` |
| Typed while a stop is pending | `queuedFollowUps(session, id)` in order, and one `run.start` row (no second root) |
| Bash approve-for-session | the `request.decided` row; that its grant field is the one to read is unverified |
| Personal-key retry | the decided row's `{ action: 'retry', credentials: 'personal' }`, and the stored preference read back from the settings store unchanged; no call count |

The frame-level behaviour (the modal, the Ctrl-C hint) is already
`validate-tui`'s `queued-followups`, `Ctrl-C stop` and approval scenarios,
in CI at `.github/workflows/ci.yml:309`. Whether the TUI harness drives a
real session is unverified.

**Deleted:** 12 `vi.mock` factories, the `mocks` bags, `makeSession`'s
stubs, and the `secretReads` spy. The three suites move out of `isolated`.

**What we give up.** The "slot claimed synchronously before the record
resolves" check (`:381`) has no outcome to read once F1's `FiberHandle`
replaces the claim. Round 1 says it is the same guarantee from one
primitive (`F-hosts.md:148-150`).

**Change amplification.** One change: "the claim becomes a
`FiberHandle`". Before: the controller, `sessionRunState.ts` and 2 suites,
whose assertions read the claim. After: the controller and
`sessionRunState.ts`.

**Depends on.** **A's K4 follow-up** (F1, F2's TUI modal onto `approve`).
Rewrite these suites in that PR, not before: the fields they pin are the
ones it deletes.

### 1.4 Suites that are not about rows hand-write the rows other code owns, so one row rename edits 20 test files

**Files and churn:** `ChildRunOutput` (7 (r)), `traceFrames` (6 (r)),
`RunProgressRenderer` (5 (r)), `ExecuteCli`, `ResumeCommand`,
`WorkflowRunCommand`, `RunRecords` / `RunListing` / `RunChildLineage`
(harness), `traceAssembler` and `sessionViewFixture`.

**Flags:** change amplification, repetition (12 copies of the `run.start`
draft beside a support builder).

**Evidence.**

- **The rename's blast radius.** #14788 (`18cecd8`) renamed one `run.start`
  field and edited 20 test files plus `golden-1.0.sql`. That is 42 changed
  lines in tests (`git show 18cecd8 --stat`).
- **12 suites write the literal.** They write `type: 'run.start'` with
  `identity`, `takesFollowUps`, `parent` and `provenance` by hand. Examples:
  - `ChildRunOutput.vitest.ts:101-108`;
  - `ResumeCommand.vitest.ts:64-71`;
  - `ExecuteCli.vitest.ts:210-217`.
- **A builder already exists.** `publishTestRunStart`
  (`sessionTestUtils.ts:56-72`) writes the same draft. It takes only
  `parent`, so a suite that needs another agent name, or
  `takesFollowUps: false`, writes its own.
- **Not counted.** The fold's and the store's own suites
  (`sessionViewUpdate`, `sessionEvents`, `fanOutScenario`) take rows as
  their input, so they are correct to write them and are not counted here.

**The design decision behind it.** Who owns a fixture row's shape. For a
suite whose subject reads a run, the row is setup. Setup should come from
one builder, or from the verb that writes it.

**The better design.** One `runStartRow(runId, over: Partial<draft>)` in
`sessionTestUtils.ts`. `publishTestRunStart` and the 12 suites use it: it
is data, with no options.

- **The CLI suites** stop needing it once 1.2 lands, because a real launch
  writes the row.
- **Deleted:** 11 literals, about 90 lines.
- **Lens 5 owns the rule-of-three side.** This finding gives only the churn
  evidence.

**What we give up.** Nothing a test reads. `traceFrames` and
`traceAssembler` parse `trace.json`, a format: their row literal stays if
it pins the document format.

**Change amplification.** One change: "a `run.start` field is renamed".
Before: 20 test files. After: `sessionTestUtils.ts`, `fanOutScenario.ts`,
the fold's and the store's suites, and the golden fixture, which makes 4 or 5.

**Depends on.** None. Sequence with **E's R3-E2**, which bumps row
versions and regenerates the golden store. Landing this first makes that
batch's test edits a single file.

### 1.5 `ToolUseFollowUp` tests follow-up admission against a hand-written session log and two module-namespace spies

**File and churn:** `packages/harness/test/agent/followUp/ToolUseFollowUp.vitest.ts`
(408 lines, 5 (r); #14788 alone edited 16 lines).

**Flags:** a fake that is a second implementation (of `SessionLog`:
sequence numbers, commits, `transact`'s two overloads, `runRows`),
information leakage (which module exports `resumeRun`).

**Evidence.**

- **A hand-written log.** `recordedFollowUps` (`:80-169`) implements
  `transact` over a one-permit semaphore and assigns
  `seq: rows.length + 1, commit: rows.length + 1` (`:101`). It is cast
  `as InboxPort['log']` (`:143`).
- **Module-namespace spies.** `fakeSession` spies the module namespaces
  `vi.spyOn(resumeRunModule, 'resumeRun')` (`:191`) and
  `vi.spyOn(resumability, 'checkpointRefusal')` (`:187`).
- **Fakes and casts.** It builds a fake `Runs`, view, log and
  `Interactions` with five `as unknown as` casts (`:197-224`).
- **Where its subject sits.** The suite's subject is reachable as a host
  verb, `session.request({ kind: 'followUp.send', … })`
  (`runtimeRequest.ts:90`, `SessionRequests.ts:327`). Its answer is
  readable as `queuedFollowUps(session, runId)`
  (`sessionTestUtils.ts:106`), a cold read of the view.

**The design decision behind it.** Whether follow-up admission is tested
against the store it writes to. The suite says what it fakes and why. But
its fake log has the sequence and commit rules the real one owns, and its
"wake" is a spy on the function's module.

**The better design.** Use a `TestSession` with `publishTestRunStart`.
Send through `session.request`, then assert `queuedFollowUps` and the
`followup.queued` rows' order.

- **The replayed-delivery case:** two sends with one `deliveryId`, then
  one row.
- **The refused-write case:** `sessionStoreFaults` failing the next
  `appendAll` (`storeFaults.ts:136-235`, a "good module" of R3).
- **The idle run's wake:** the run's `run.activate` row count, as
  `resumeRun.vitest.ts`'s `activations` reads it. That count holds over a
  `validationHost` run that parks.
- **Deleted:** `recordedFollowUps`, `fakeSession`, `withResumePort` /
  `tryResume`, two namespace spies and five casts. That is about 190 lines.

**What we give up.** It gives up the "a resume that answers `REFUSED`"
case without a real run. A refused resume then needs a real reason, such as
a checkpoint the store refuses (unverified that one is cheap to build).

**Change amplification.** One change: "the log's `transact` gains an
overload or a field". Before: `runHistory.ts` and this suite's fake. After:
`runHistory.ts`.

**Depends on.** None.

### 1.6 Three tool suites fake the process one call too high, at `executeCommand`, instead of at the spawner

**Files and churn:** `packages/harness/test/tools/BashTool.vitest.ts`
(275 lines, 5 (r)), `ExecutionsToolOutput.vitest.ts` (217, 3 (r)),
`grep.vitest.ts`.

**Flags:** information leakage (the helper's option bag and `ExecResult`
are the test's interface), repetition (a second fake for the process edge
beside the shared one).

**Evidence.**

- **The sites.** These are `vi.spyOn(execUtils, 'executeCommand')` at
  `BashTool.vitest.ts:49`, `:154`, `:209`, at
  `ExecutionsToolOutput.vitest.ts:63`, and at `grep.vitest.ts:22`.
  - The stubs call `options?.onStdout?.(…)` (`BashTool:212-213`) and return
    hand-built `ExecResult`s.
  - `BashTool:172` also spies `resumeRunModule.resumeRun`, and
    `ExecutionsToolOutput:73` spies `toolUseFollowUp.wakeIfOwed`.
- **The real edge.** `executeCommand` runs on `ChildProcessSpawner`
  (`execUtils.ts:16`, `:455`). The shared fake for that edge,
  `scriptedSpawnerLayer` (`childProcessTestLayer.ts:69`), is the one R3
  named a good module (6 suites).
- **The assertions are good.** They are on the tool's result
  (`BashTool.call(...)`, `:224`) and on `readRunEnd()` (`:262`).

**The design decision behind it.** Where a tool suite fakes a process. A
suite that stubs `executeCommand` cannot catch a bug in it. Examples are
`executeCommand`'s chunk decoding (the surrogate-pair case at `:203` is
exactly that kind), its timeout, and its exit-code mapping.

**The better design.** Provide `scriptedSpawnerLayer(...).layer` innermost,
answering `{ stdout, exitCode }`. Assert the same tool results.

- **What the spawner lacks.** `holdCommand` (a command released later with
  exit 143, `:47-55`) and the two-chunk stdout need two things
  `ScriptedAnswer` lacks: a `stdout` stream and an `exitCode` effect (such
  as `Deferred.await`). That is one field each on the existing union, which
  serves every spawner suite.
- **The `resumeRun` spy** (#8093 regression) reads the registry at the
  instant of the wake. It is the one place a namespace spy marks a moment
  no row records. Keep it, with the one-line comment the one-fake rule asks
  for, or replace it with the parent's `run.activate` row and the child's
  `run.end` commit order (unverified that the order alone shows the race).
- **Deleted:** 5 `executeCommand` spies, `holdCommand`, the hand-built
  `ExecResult`s and the `wakeIfOwed` spy.

**What we give up.** Speed. A scripted spawner runs `executeCommand`'s real
stream handling, which costs little.

**Change amplification.** One change: "`executeCommand`'s options are
renamed". Before: `execUtils.ts`, its callers, and 3 suites. After: the
first two.

**Depends on.** None.

### 1.7 Desktop E2E specs read Lit components' properties, not what the person sees

**Files and churn:** `packages/desktop/tests/e2e/sessionLifecycle.spec.ts`
(churn 5 (r)), `settingsPersistence.spec.ts` and `trajectories.spec.ts`.

**Flags:** information leakage (the `RunView` field names in a Playwright
spec). This breaks the E2E rule "Drive the app through user-visible roles,
labels, and text" (`src/test-kernel/AGENTS.md`).

**Evidence.**

- **`sessionLifecycle`** (`:189-196`) reads
  `(tab as HTMLElement & { run: { position: string } }).run.position` and
  `.run.holder` off each `run-tab`. #14789 (R6) rewrote it from
  `.run.status` / `.run.group`, with no change to what the person sees.
  #14788 edited it for `takesFollowUps`.
- **`settingsPersistence`** (`:76`) reads `memory-item`'s `.item`
  property.
- **`trajectories`** (`:306-326`) reads `texra-diff-view`'s
  `originalText` / `proposedText` / `language` props: "verifying the
  contract is enough".
- **The visible surface exists.** `RunTab.ts:318-323` renders the status as
  `role="img"` with `aria-label=${accessibleStatusLabel}`, the status word.
  `devStartup.spec.ts:235` already asserts the diff through Monaco's
  rendered text (`.modified-in-monaco-diff-editor`).

**The design decision behind it.** What an E2E assertion is about. A
spec that reads `.run` is a unit test of the view model, run through
Electron at E2E cost, and pinned to the view's field names.

**The better design.**

| Spec | Replacement |
| --- | --- |
| `sessionLifecycle` | for each tab, `getByRole('img', { name: <status word> })`, where both restarted runs show the interrupted word |
| `settingsPersistence` | the memory row's visible text |
| `trajectories` | the diff pane's rendered `old body` / `new body`, as `devStartup` does |

**Deleted:** three `HTMLElement & {…}` property reads.

**What we give up.** It gives up a direct check that `holder === 'none'`.
The status word must be distinct for "waiting, nobody holds it". Whether
`status.word` says so for both restarted runs is unverified; if not, that
is a UI gap the spec should expose.

**Change amplification.** One change: "a `RunView` field is renamed".
Before: the schema, the fold, and the UI and `sessionLifecycle.spec.ts`
(the E2E edit runs only on desktop CI). After: no E2E edit.

**Depends on.** None.

### 1.8 Smaller items, batched

- **Relative imports into other packages' `src/`.** These bypass the
  public entries and the aliases (7 sites in 6 suites):
  - `RetryState.vitest.ts:87`, `:91` (llm `verdict.js`, `turn.js`);
  - `resumeRun.vitest.ts:53` and `effect/sessionPrograms.vitest.ts:34`
    (`makeSessions` from `packages/harness/src/effect/sessionPrograms`, with
    an `as never` owner at `resumeRun:119`);
  - `traceFrames.vitest.ts:11` and `traceAssembler.vitest.ts:28`
    (trace-viewer);
  - `llm/GoogleInteractions.vitest.ts:14`.

  The two trace-viewer ones test `trace.json`, a format. The rest fall
  under the 10-27 note's §4 A1 codemod: cited, not re-reported.
- **`resumeRun.vitest.ts` calls `resumeRun` directly** (`:64`). It already
  builds the public session (`packageSession`, `:115-123`), whose
  `session.resume(runId)` is the host verb. Fix: resume through it in the
  cases that do not need the internal options. Unverified which cases need
  them.
- **`SessionHandle.vitest.ts` reads the internal `Approvals.policy()`**
  (`:64`, `:70`, `:78`) to show that a reconnecting window cannot replace
  the persisted policy. Fix: assert what a run started after the change
  records, which is its policy in the view's `policy` map
  (`sessionView.ts:320`). Unverified that the map carries the session
  policy at start.

## Good suites worth copying

- **`shared/session/sessionViewUpdate.vitest.ts`:** rows in, view or run
  state out.
  - It writes literal expectations and builds its views through
    `fanOutScenario`'s updater.
  - It checks that an incremental fold equals a cold one (`:420-421`).
  - Its churn (8 (r)) is the view's real shape changes (R6), which a
    projection suite should feel.
- **The "Sessions owner" case in `sessionEvents.vitest.ts:389-465`:**
  `Sessions.open` on a persistent store, then `session.request` and
  `session.view`. It uses only public verbs and asserts the request stays
  pending.
- **`ToolUseDispatchParallel`'s assertions:** `runRows(…, 'results')`
  order and dispositions, the folded `edited`, and card counts. These are
  the right outcomes; finding 1.1 only moves the entry.
- **`resumeRun.vitest.ts` and `sessionStore.vitest.ts` over
  `validationHost`:** a real store, the model at its edge, and
  `run.activate` / `run.end` rows as the oracle (once C3's raw reads are
  decoded).
- **`cli/CliRootArgs.vitest.ts`:** `runCli(argv)` to exit code and stream
  routing, with no mocks. This is the boundary 1.2 asks the command suites
  to use.
- **`packages/llm/test/api/*`** (for example `AnthropicMessages.vitest.ts`):
  faked at `fetch`, asserting the vendor wire body and headers. That is a
  protocol TeXRA still speaks, so pinning it is the contract.
- **`supabase/functions/*_test.ts`:** small handler and validator tests at
  their HTTP boundary, with churn 1.

## Already settled, left alone

- **The store suites.** `sessionEvents.vitest.ts` and `goldenStore.vitest.ts`
  (churn 13 and 11) are pinned mainly through what the 11-04 note already
  lists (`.agents/docs/proposed/simplification/2026-11-04-store-and-test-support-debts.md`):
  - C1: `RESPONSE = 605`, and ids by first appearance;
  - C2: two copies of `sessionGraphLayer`;
  - C3: raw `event.data` reads;
  - C5: `killedHost`;
  - C6: `user_version: 101`, `busy_timeout` and the `_tag` cause shapes;
  - C7: the `vi.mock`s that keep the suite `isolated`.

  Their remaining raw SQL is the store's own acceptance (the outline
  encoding, collection, the ordinal never reused, `sessionEvents.vitest.ts:829-1000`).
  The store's format is a versioned contract (`packages/harness/AGENTS.md`
  "Storage format").
- **R3's other residue.** The scripted-model residue in 1.1 is R1's
  (`../2026-11-07-design-red-flags-round-3/R-test-infrastructure.md:102`),
  reported here only with its churn evidence and what #14823 left. R2, R3,
  R4 and R6 landed (#14823, #14826).
- **Deep imports in general, and `sessionHandleOf` (28 suites).** This is
  the 10-27 note's §4 A1 and its `SessionHandle (28)` count
  (`.agents/docs/proposed/architecture/2026-10-27-tech-debt-target-designs.md`).
  It is not repeated per suite.
- **The E2E `window.postMessage` drivers and raw-SQL reads.** These are
  R3's R8 (`R-test-infrastructure.md:620-633`).
- **`validationModel` in the production tree.** This is `K-cli.md:835`,
  and #14823 made its scenario a value (R5).
- **`sessionViewUpdate`, `traceFrames` and `traceAssembler` writing rows
  by hand.** Their subject takes rows or a `trace.json` document as input.
  A literal is the right fixture there ("write the expected output down as
  a literal").
- **`ChildRunOutput` calling `resolveChildRunOutput`.** This is the
  module's own suite over a real session and real files. Only its row
  literal is in 1.4.
