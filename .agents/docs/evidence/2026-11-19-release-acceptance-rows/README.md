# Release acceptance R1–R24 after the rows were restated: deterministic evidence, 2026-11-19

The second note of the day on the 1.0 acceptance table in
[the harness 1.0 PRD](../../proposed/architecture/2026-10-28-harness-1-release-prd.md)
("发布验收"). The first,
[`2026-11-19-release-acceptance/`](../2026-11-19-release-acceptance/README.md),
ran every deterministic check on `main` and found that 13 of the 24 rows could
not be called passed by a check that runs: seven had none, six had part of one.
It stays as the record of that run.

This note records what was done about it and the rerun:

- The rows that described a design `main` no longer has were restated to what
  the product guarantees now, and one was withdrawn. The table of old text,
  new text and the PR that changed the design is in the PRD, under the
  acceptance table.
- Each standing row that had no check, or part of one, got one. They are
  three packed examples (`11`, `12`, `13`), a fourth step of example `08`,
  and one case in the golden store suite.
- Every deterministic check was run again on that tree. **All passed; no
  product defect was found.**

Tree: this PR's branch with `main` @ `fb12553` (#15080) merged into it, in a
Linux container (Node 22.23.5, 4 cores). The two CLI validators ran on the
branch before that merge (`main` @ `66874b1af9`, #15064, plus the same test
commits); this PR changes nothing they run. The real-model half did not run
here; its status is in
[`2026-11-03-harness-real-model/`](../2026-11-03-harness-real-model/README.md).

## Commands

All from the repository root, after `corepack pnpm install --frozen-lockfile`,
each as `.github/workflows/ci.yml` invokes it.

| Check                                           | Command                                                                                 | Result                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Kernel tests (CI step 1, unsharded)             | `pnpm run test --project pure --project kernel --sequence.shuffle.files --maxWorkers=2` | 233 files, 564 passed, 1 skipped; seed `1795106423218`                |
| Isolated and crash tests (CI step 2, unsharded) | `pnpm run test --project isolated --project crash --maxWorkers=2`                       | 25 files, 58 passed                                                   |
| CLI real-runtime validation (nightly job)       | `pnpm --filter @texra-ai/cli validate:run`                                              | "CLI run validation passed"                                           |
| TUI frames, every scenario (CI runs `--smoke`)  | `pnpm --filter @texra-ai/cli validate:tui -- --snapshot-dir <dir>`                      | all 143 scenarios passed                                              |
| Packed example ladder                           | `pnpm --filter @texra-ai/harness run example:packed`                                    | tarballs installed outside the repo, type-checked, examples 01–13 ran |
| Static checks                                   | `npm run typecheck`, `npm run gate`                                                     | both exit 0                                                           |

## The failure each new check is for

Written before the checks, one sentence a row.

- **R3**: two resumes of one run, or a resume racing the wake a message
  causes, each activate it, and the queued message is answered twice.
- **R4**: a resume whose caller was interrupted leaves a run the session's
  close does not release, so the store stays locked or the process never
  exits.
- **R7**: a script that had started is replayed on the plugin module as it
  is registered now, not on the source it started with, and its replay
  diverges.
- **R11**: a run bound to a backend this build no longer has is activated,
  or sends a request, before anything says the backend is gone.
- **R13** (model switch): a switch asked right after a resume is lost, or
  the next turn is still requested from the old model.
- **R16**: a resume whose caller leaves before the answer either never runs
  the run or leaves one nobody can reach: a second resume starts a second
  activation, or a message to it is answered twice or not at all.
- **R17**: a run whose handle was built and never handed over cannot be
  stopped and is not released by the session's close.
- **R18**: `/model` or `/compact` sent to a run just resumed is refused as if
  nobody ran it, or is answered only when the run ends.
- **R19**: a root run that fails on a model error fails `run.result`
  (`RunFailure`) instead of answering its stored end, or the end's error is
  unclassified.
- **R21**: messages taken by a turn whose request the provider refuses are
  lost, sent twice with the next turn, or shown as answered.
- **R23** (reader): a reader that stops waiting on `run.result` stops the
  run.

## R1–R24

"Check" names a suite by path and test title or an example by file. `CC` is
`src/test-kernel/support/crashConformance.ts`, run by the
`crashConformance*.vitest.ts` suites in
`packages/harness/test/controllers/session/`. `EX` is
`packages/harness/example/`, run as a consumer of the packed packages over
real files and SQLite, on a scripted model. **New** marks a check this PR adds.

| Row | Deterministic check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Result                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| R1  | The packed ladder: examples 01–13 import published subpaths only, start runs and read `run.result`. `EX` 11 (**new**) closes a session with a live run and reopens its store in the same process three times, and every example's process exits by itself.                                                                                                                                                                                                                                                                     | pass                              |
| R2  | `CC` "resumes from every commit point to the clean outcome, running nothing twice"; `src/test-kernel/controllers/session/goldenStore.vitest.ts` "reports the command as an unknown outcome and never reruns it"; `EX` 08 (real SIGKILL after a child's result commits).                                                                                                                                                                                                                                                        | pass                              |
| R3  | `EX` 11 (**new**), steps 2 and 3: a message that wakes the run and two `session.resume` calls, all at once, produce one model request for the message (the scripted model refuses any other), one held run, and two handles; a reader of `run.result` is interrupted and the run is still held with no end.                                                                                                                                                                                                                    | pass                              |
| R4  | `EX` 11 (**new**), steps 4 and 5: a `session.resume` is interrupted before it answers, the session is then closed with the run live, and the store reopens in the same process with nothing held and the run not ended and resumable. `packages/harness/test/effect/sessionPrograms.vitest.ts` "records a stop of a launch still opening on its run's end"; `packages/harness/test/agent/AgentPackage.vitest.ts` "fails the run instead of hanging when the session fold dies before the final view" (the view-update clause). | pass                              |
| R5  | `CC` "reads every child result settled before the crash, exactly once"; `EX` 08; `packages/harness/test/agent/followUp/ToolUseFollowUp.vitest.ts` "admits a replayed child delivery at most once".                                                                                                                                                                                                                                                                                                                             | pass                              |
| R6  | `src/test-kernel/agent/runtime/AgentLaunchActivation.vitest.ts` "R6: an agent file and its equivalent inline persona are offered the same tools and asked the same approvals"; `EX` 07 (same system text and tool names).                                                                                                                                                                                                                                                                                                      | pass                              |
| R7  | `EX` 08 (**new** step 4): the script imports `builtIn:review`; the process that resumes registers a changed edition of that module; the replayed script returns the edition it started with, and a script the model writes after the resume returns the changed one. `EX` 07 imports `builtIn:latex`; `packages/harness/test/agent/CodeSandbox.vitest.ts` "a script imports the modules it is given, and only those, by name" (the missing-module error).                                                                      | pass                              |
| R8  | `EX` 09: two goal strategies, two `self` rounds each, forked and fresh context, pause reasons and spend checked.                                                                                                                                                                                                                                                                                                                                                                                                               | pass                              |
| R9  | `EX` 10: the packed `acme-notes` plugin, removed (fact read as written, resume refused `pluginUnavailable`), then restored; `packages/harness/test/controllers/session/rowCodec.vitest.ts` "reads a fact of an absent plugin as written, saying why".                                                                                                                                                                                                                                                                          | pass                              |
| R10 | `packages/harness/test/agent/ToolUseDispatchParallel.vitest.ts` "delivers bounded SQL pages as data to a script"; `packages/harness/test/agent/runtime/HistoryQuery.vitest.ts` "refuses a write and a second statement"; `EX` 07 (call facts and child runs by SQL, write refused).                                                                                                                                                                                                                                            | pass                              |
| R11 | `goldenStore.vitest.ts` "decodes every row to an event, …", "refuses a store a newer build wrote to, and rewrites nothing", and "refuses a run holding … before any request, and adds no row", which gains the case "a run.config bound to a backend this build does not have" (**new**): the resume fails naming the backend, no turn is sent, the store's rows are unchanged.                                                                                                                                                | pass                              |
| R12 | A review of change scope. Its mechanical clause is `npm run gate`: oxlint's import bans with their `except` tables, and `check:fact-spread`, shrink-only against the merge base. "旧路径已删除" is a judgement no check decides; the PRD records the 2026-11-03 measurement of the three everyday changes.                                                                                                                                                                                                                     | gate passes; the rest is a review |
| R13 | `src/test-kernel/agent/runtime/resumeRun.vitest.ts` "a store read that fails under a resume fails it with the store's error, activates nothing and keeps the queued input" and "input sent while a resume reads the run reaches the resumed run"; `EX` 12 (**new**): `run.model` right after the resume is answered, and the summary and the next turn are requested from the new model.                                                                                                                                       | pass                              |
| R14 | `sessionPrograms.vitest.ts` "R14: resuming a child its parent's open call owns resumes the parent once, names the child, and leaves no listener".                                                                                                                                                                                                                                                                                                                                                                              | pass                              |
| R15 | `resumeRun.vitest.ts` "a user's stop while a resume decides records its reason, ends the run cancelled, and the resume activates nothing".                                                                                                                                                                                                                                                                                                                                                                                     | pass                              |
| R16 | `EX` 11 (**new**), step 4: a `session.resume` forked and interrupted; the run is held by the session all the same; a second resume is answered a handle and a message sent then is answered by exactly one model request; step 2 is the wake.                                                                                                                                                                                                                                                                                  | pass                              |
| R17 | `EX` 11 (**new**), steps 4 and 5: the run of the interrupted resume is listed by `session.held`, is released by the session's close, and after a reopen a `run.stop` ends it `cancelled` with nothing held.                                                                                                                                                                                                                                                                                                                    | pass                              |
| R18 | `EX` 12 (**new**): before the resume `run.model` is `Unavailable` with its reason; right after it `run.model` and `run.compact` are both answered `done` within their timeout while the run is held with no end; the compaction then runs and the next turn uses the new model.                                                                                                                                                                                                                                                | pass                              |
| R19 | `EX` 13 (**new**), step 4: a run-once root whose request is refused with 400 answers `run.result` with `outcome: 'failed'`, `error.kind: 'model'` and a `provider-rejection` failure with status 400. `sessionPrograms.vitest.ts` "fails a run's result with what the store refused of its end" (the `RunFailure` side).                                                                                                                                                                                                       | pass                              |
| R20 | Withdrawn (PRD table): caller ids and receipts were deleted by #14943, and a send is one message.                                                                                                                                                                                                                                                                                                                                                                                                                              | withdrawn                         |
| R21 | `EX` 13 (**new**), steps 1 to 3: two messages sent while a turn waits on the model are both consumed with `disposition: { kind: 'turn', turn: 2 }`; that turn's request is refused; one classified error row, no answer in the stored conversation, the run waits with no end; the next turn's request holds each message once and the conversation then holds one answer.                                                                                                                                                     | pass                              |
| R22 | `packages/harness/test/agent/runtime/loop/hooks.vitest.ts` "R22: a rewrite committed before a crash keeps the original call, runs only the rewritten input, and never runs the hook again".                                                                                                                                                                                                                                                                                                                                    | pass                              |
| R23 | `resumeRun.vitest.ts` "resumed as soon as its end is stored, runs a new activation to its own end" (the old activation's fiber still leaving); `EX` 11 (**new**), step 3 (a reader that leaves does not stop the run); `EX` 05 (the first handle still reads its own activation's events while the resumed one runs).                                                                                                                                                                                                          | pass                              |
| R24 | `src/test-kernel/controllers/session/sessionStore.vitest.ts` "R24: a commit whose view never shows it fails its caller, and the committed rows stand".                                                                                                                                                                                                                                                                                                                                                                         | pass                              |

Of the 23 standing rows, 22 have a deterministic check that passes, and R12 is
a review whose mechanical part is the gate.

## Where the new checks sit, and why

The repository asks that acceptance be end to end and end in something a
reviewer can run again (`src/test-kernel/AGENTS.md`). The R18, R20 and R21 cases that
were removed lived in `resumeRun.vitest.ts`, a suite over internal modules.
The new checks use only the
published surface (`Sessions`, `session.resume`, `session.request`,
`session.held`, `run.result`, `session.view`), so a refactor inside the
harness cannot remove them without changing what a consumer sees:

- `packages/harness/example/11-resume-ownership.ts` (R3, R4, R16, R17, R23)
- `packages/harness/example/12-controls-on-a-resumed-run.ts` (R13, R18)
- `packages/harness/example/13-failed-turn.ts` (R19, R21)
- `packages/harness/example/08-crash-and-resume.ts`, step 4 (R7)
- one more row of the `it.effect.each` table in `goldenStore.vitest.ts`
  (R11): a withdrawn backend is a store rewrite no public call can make.

What the examples cannot do is hold a resume at one chosen read, as the
earlier note's probes did with the kernel's store faults. Example 11
interrupts the resume's caller one scheduler turn after it was forked, and
checks what must hold wherever the interruption lands: the run is held, a
second resume is answered, a message is answered once.

## Observed, not failures

- **A failed turn of an interactive run does not end the run.** The run
  records the classified failure and waits for input (`EX` 13). R19 is about
  a root that ends, so its check uses a run launched to run once.
- **A withdrawn backend fails the resume as `RunFailure`, not
  `ResumeRefused`.** The message names the backend ("This conversation ran on
  withdrawn, which this build no longer supports. Start a new chat."), nothing
  is sent and no row is written, which is what R11 asks. `ResumeRefusal` has
  no kind for it.
- **Two handles of one activation still carry different ordinals** (`EX` 11
  prints them, 23 and 22), as the earlier note found. Both read the same
  activation.

## Still not covered here

Live model only (no provider key in this container; nothing below was faked):

- `example:acceptance` on the two routes the PRD names. DeepSeek passed on
  2026-11-03; Anthropic has not run.
- `npm run test:live` (one suite per provider route) and
  `packages/cli/scripts/validate-journeys.mjs` (polish, latexFixer, latexdiff,
  citations, prove).

A platform this container lacks:

- The Windows kernel shards (nightly).
- The VS Code host e2e (`npm run test:vscode`): a VS Code download and a
  display; CI runs it on macOS.
- The desktop e2e and the build-artifacts job, which CI runs on macOS. They
  map to no R row; the earlier note ran them once under xvfb.

No R row is live-only. R12's "旧路径已删除" needs a person.
