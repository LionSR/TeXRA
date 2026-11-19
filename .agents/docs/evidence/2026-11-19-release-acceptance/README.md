# Release acceptance R1–R24 on `main`: deterministic evidence, 2026-11-19

The deterministic half of the 1.0 acceptance in
[the harness 1.0 PRD](../../proposed/architecture/2026-10-28-harness-1-release-prd.md)
("发布验收"), run whole on `main` @ `e9e6ffad4bfe0b102efcdc75213779382e2d078e`
(#15020) in a Linux container (Node 22.23.5, 4 cores). The real-model half is
separate and did not run here; its status is in
[`2026-11-03-harness-real-model/`](../2026-11-03-harness-real-model/README.md).

**Every deterministic check that ran passed. No product regression and no
stale validator was found.** What was found is about the acceptance table
itself:

- Two rows, and a clause of two more, describe a feature `main` no longer has. #14943 (2026-11-14)
  deleted follow-up receipts and caller ids on the owner's deletion list, so
  R20 and R21 have nothing to run against, and the receipt clauses of R13 and
  R18 likewise. The PRD still said the R18, R20 and R21 cases were in
  `resumeRun.vitest.ts`; this PR corrects that sentence. Whether the rows are
  withdrawn or restated is the owner's decision.
- The acceptance tests for R3, R7, R16, R18 and R21 were deleted by #14615
  (2026-11-03, "drop duplicate CLI resume and cancelled-output cases") and the
  R13 one by #14943. Those rows now have no check, or only part of one.
- R16's first clause no longer describes the design: a resume whose only
  caller leaves is not stopped. The run is the session's
  (`RunRegistry.start`), so it is activated and stays held by the session; a
  second resumer is answered the running activation.

## Commands

All from the repository root, after `corepack pnpm install --frozen-lockfile`,
each as `.github/workflows/ci.yml` invokes it.

| Check                                           | Command                                                                                 | Result                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Kernel tests (CI step 1, unsharded)             | `pnpm run test --project pure --project kernel --sequence.shuffle.files --maxWorkers=2` | 231 files, 556 passed, 1 skipped; seed `1795093854003`                |
| Isolated and crash tests (CI step 2, unsharded) | `pnpm run test --project isolated --project crash --maxWorkers=2`                       | 25 files, 57 passed                                                   |
| CLI real-runtime validation (nightly job)       | `pnpm --filter @texra-ai/cli validate:run`                                              | "CLI run validation passed"                                           |
| TUI frames, every scenario (CI runs `--smoke`)  | `pnpm --filter @texra-ai/cli validate:tui -- --snapshot-dir <dir>`                      | all 143 scenarios passed                                              |
| Packed example ladder                           | `pnpm --filter @texra-ai/harness run example:packed`                                    | tarballs installed outside the repo, type-checked, examples 01–10 ran |

The two test steps together are the four projects of `npm test`.

## Not run, and why

- **Live-model routes**: `example:acceptance` (Anthropic, DeepSeek),
  `npm run test:live`, and `packages/cli/scripts/validate-journeys.mjs`. No
  provider key is set in this container. Every journey in
  `validate-journeys.mjs` calls a real model, so none of them is a
  deterministic check.
- **Windows kernel shards**: Linux container. The three Windows-only nightly
  failures belong to another session.
- **VS Code host e2e** (`npm run test:vscode`): needs a VS Code download and a
  display; CI runs it on macOS.
- **Desktop e2e and the build-artifacts job**: see "Other CI jobs" below.

## R1–R24

"Check" names a suite by path and test title, an example by file, or "probe"
for a one-off test written for this note and not committed (see below).
`CC` is `src/test-kernel/support/crashConformance.ts`, run by the
`crashConformance*.vitest.ts` suites in
`packages/harness/test/controllers/session/`. `EX` is
`packages/harness/example/`.

| Row | Deterministic check                                                                                                                                                                                                                                                                                                                                                                 | Result                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| R1  | The packed ladder: examples 01–10 import published subpaths only, start runs and read `run.result`. No example asserts that a resource closed; a leak would show only as a hang.                                                                                                                                                                                                    | pass; resource release only implied        |
| R2  | `CC` "resumes from every commit point to the clean outcome, running nothing twice"; `src/test-kernel/controllers/session/goldenStore.vitest.ts` "reports the command as an unknown outcome and never reruns it"; `EX` 08 (real SIGKILL after a child's result commits).                                                                                                             | pass                                       |
| R3  | **No committed check** (deleted by #14615). Probe: two resumes at once activated the run once, one answer to the queued input, and both callers' `Run.result` read the same end.                                                                                                                                                                                                    | no coverage; probe passed                  |
| R4  | Part: `packages/harness/test/effect/sessionPrograms.vitest.ts` "records a stop of a launch still opening on its run's end"; `packages/harness/test/agent/AgentPackage.vitest.ts` "fails the run instead of hanging when the session fold dies before the final view". Nothing cancels at the handoff and then closes the session.                                                   | partial, passed                            |
| R5  | `CC` "reads every child result settled before the crash, exactly once"; `EX` 08; `packages/harness/test/agent/followUp/ToolUseFollowUp.vitest.ts` "admits a replayed child delivery at most once".                                                                                                                                                                                  | pass                                       |
| R6  | `src/test-kernel/agent/runtime/AgentLaunchActivation.vitest.ts` "R6: an agent file and its equivalent inline persona are offered the same tools and asked the same approvals"; `EX` 07 (same system text and tool names).                                                                                                                                                           | pass                                       |
| R7  | Part: `EX` 07 imports `builtIn:latex`; `packages/harness/test/agent/CodeSandbox.vitest.ts` "a script imports the modules it is given, and only those, by name" (the missing-module error). The module changed between a started script and a new step: **no check** (the R7 test was deleted by #14615).                                                                            | partial, passed                            |
| R8  | `EX` 09: two goal strategies, two `self` rounds each, forked and fresh context, pause reasons and spend checked.                                                                                                                                                                                                                                                                    | pass                                       |
| R9  | `EX` 10: the packed `acme-notes` plugin, removed (fact read as written, resume refused `pluginUnavailable`), then restored; `packages/harness/test/controllers/session/rowCodec.vitest.ts` "reads a fact of an absent plugin as written, saying why".                                                                                                                               | pass                                       |
| R10 | `packages/harness/test/agent/ToolUseDispatchParallel.vitest.ts` "delivers bounded SQL pages as data to a script"; `packages/harness/test/agent/runtime/HistoryQuery.vitest.ts` "refuses a write and a second statement"; `EX` 07 (call facts and child runs by SQL, write refused).                                                                                                 | pass                                       |
| R11 | `goldenStore.vitest.ts` "decodes every row to an event, …", "refuses a run holding … before any request, and adds no row", "refuses a store a newer build wrote to, and rewrites nothing". A withdrawn backend is shown readable (`rowCodec.vitest.ts` "reads a run.config bound to a backend this build does not have"), but no check resumes such a run and sees no request sent. | pass; withdrawn-backend resume not checked |
| R12 | A review of change scope, not a scenario; nothing deterministic decides it. The PRD records the 2026-11-03 measurement and leaves "旧路径已删除" open.                                                                                                                                                                                                                              | no coverage                                |
| R13 | Part: `src/test-kernel/agent/runtime/resumeRun.vitest.ts` "a store read that fails under a resume fails it with the store's error, activates nothing and keeps the queued input" and "input sent while a resume reads the run reaches the resumed run". A model switch during a resume: no check. The receipt clauses: feature deleted (#14943).                                    | partial, passed                            |
| R14 | `sessionPrograms.vitest.ts` "R14: resuming a child its parent's open call owns resumes the parent once, names the child, and leaves no listener".                                                                                                                                                                                                                                   | pass                                       |
| R15 | `resumeRun.vitest.ts` "a user's stop while a resume decides records its reason, ends the run cancelled, and the resume activates nothing".                                                                                                                                                                                                                                          | pass                                       |
| R16 | **No committed check** (deleted by #14615). Probe: a resume interrupted before it launched still activated the run, which the session held with no stop and no end; a second resume was answered that activation and the queued input was answered once. The "no joiner: stopped" clause no longer matches the design.                                                              | no coverage; probe passed, clause 1 stale  |
| R17 | **No check.** Nearest: `sessionPrograms.vitest.ts` "records a stop of a launch still opening on its run's end".                                                                                                                                                                                                                                                                     | no coverage                                |
| R18 | **No check.** The row is worded on the input receipt, which #14943 deleted; when `/model` or `/compact` is answered during a resume is asserted nowhere.                                                                                                                                                                                                                            | no coverage                                |
| R19 | Part: `sessionPrograms.vitest.ts` "fails a run's result with what the store refused of its end" (the `RunFailure` side). Probe, on the packed packages: a root run whose model request was refused with 400 read `run.result` as a `RunEnd` with `outcome: "failed"` and `error: { kind: "model", failure: { kind: "provider-rejection", status: 400 } }`.                          | partial; probe passed                      |
| R20 | **No check; the feature is gone.** `followUp.send` takes no caller id since #14943.                                                                                                                                                                                                                                                                                                 | no coverage                                |
| R21 | **No check; the feature is gone** (receipts, #14943).                                                                                                                                                                                                                                                                                                                               | no coverage                                |
| R22 | `packages/harness/test/agent/runtime/loop/hooks.vitest.ts` "R22: a rewrite committed before a crash keeps the original call, runs only the rewritten input, and never runs the hook again".                                                                                                                                                                                         | pass                                       |
| R23 | Part: `resumeRun.vitest.ts` "resumed as soon as its end is stored, runs a new activation to its own end". A late write of the old activation, and an observer cancelling its wait, are not asserted (the R16 probe's first caller left and the run went on).                                                                                                                        | partial, passed                            |
| R24 | `src/test-kernel/controllers/session/sessionStore.vitest.ts` "R24: a commit whose view never shows it fails its caller, and the committed rows stand".                                                                                                                                                                                                                              | pass                                       |

No coverage at all: **R3, R12, R16, R17, R18, R20, R21**. Partial: R4, R7,
R11, R13, R19, R23.

## Probes

Three one-off checks, run on the same commit and not committed (the repository
adds a test only for a reproduced defect, and none was reproduced). They are
evidence that the behaviour held once, not coverage.

- **R3 and R16**: a kernel suite beside `resumeRun.vitest.ts`, over
  `waitingRunAfterCrash` and `sessionStoreFaults` from
  `src/test-kernel/support/storeFaults.ts`, holding the resume at its
  `readAggregate` read. Results are in the table.
- **R19**: an eleventh example run as a packed consumer through
  `packages/harness/scripts/example-packed.mjs`, its scripted model answering
  the first request with 400.

One thing the R3 probe showed that is not a failure: the two callers of one
resume are answered different ordinals for the same activation. The launcher
gets the commit of the activation's batch (76 in the probe: `run.activate` at
75, `run.config` at 76) and the joiner gets the `run.activate` row's own
commit (75, `joinOpening` in `packages/harness/src/agent/runtime/resumeRun.ts`).
Both handles read the same result and neither ended early, so nothing breaks
today, but `Run.activation` is documented as one fact and has two values.

## Other CI jobs

Run for completeness; none of them maps to an R row.

- **Build artifacts**: `pnpm --filter texra build:fast` packaged
  `releases/texra-0.41.0.vsix`, and `node scripts/verify-vsix-contents.mjs`
  passed.
- **Desktop e2e**, which CI runs on macOS only, run here on Linux under xvfb:
  `pnpm run desktop:build`, then
  `xvfb-run --auto-servernum pnpm --filter @texra/desktop test:e2e -- --trace off`.
  24 passed, 2 skipped themselves (macOS-only), 1 failed and 2 after it in
  the same serial file did not run. The failure is
  `packages/desktop/tests/e2e/workspaceTabs.spec.ts` "keeps browser menus
  above native content and close controls inside tab bounds": the browser
  tab's close button is not what a hit test at its centre finds. It repeats
  when the file runs alone. The macOS job passed this suite on #15060 the same
  day, four commits earlier, and nothing since touches the desktop, so this
  is read as a Linux or xvfb difference in a job that has never run on Linux,
  not as a regression. It is not fixed here: desktop work belongs to other
  sessions (#14961, #15062, #14765).
