---
created: 2026-10-30
status: implemented
---

# The harness against pi-durable and DeepSeek Harness, by Ousterhout's criteria

The owner decisions are listed at the end.

Measured 2026-10-30 at TeXRA `808521a8ed`, pi `31ade0e0`
(`packages/durable`, published as pi-durable 1.4.0) and DeepSeek Harness (dsh)
`ce7073d5` (0.2.2-alpha.2). Three independent read-only passes, one per
codebase, produced notes with file and line evidence against the same template;
this note is the comparison and the design that follows from it. It builds on
the [general-package design](../../proposed/architecture/2026-10-21-harness-general-package-design.md)
(surface, layout, ports) and the
[tech-debt target designs](../../proposed/architecture/2026-10-27-tech-debt-target-designs.md) (one owner
per run-lifecycle fact) and does not restate them. Two of the problems found
here are already designed there; this note says which and designs the rest.
Peer file paths are written with a `pi:` or `dsh:` prefix.

## Summary

The three harnesses solve one problem with three composition models. TeXRA runs
one Effect program per run over a SQLite row log, with a claim per aggregate
proved by kernel facts. pi-durable runs a durable task scheduler (phase state
machines) over one Session commit line, with Chord documents for mutable state.
dsh is a Cordis plugin tree: the loop, the log and the tool registry are
services on a shared context, extension is by typed events, and composition is
YAML patches.

By Ousterhout's criteria the three land close together on module depth and
information hiding (3, 3, 3 out of 5) and apart on the rest. TeXRA is the only
one with cross-process ownership: pi-durable has none (a second opener rewrites
the first opener's running tasks and runs them), dsh has a non-expiring file
lock. TeXRA's weaknesses are specific and measured: the per-call path is one
804-line function and a call passes about 24 named functions in 14 files; a
run's start and end are cut by time across ten modules (2,668 lines); "who runs
this run" has four answers; 15 row types are read outside their reducers in 43
file entries; six in-flight facts have a memory twin; 11 sites warn and
continue over a lost durable fact; and churn is high (372 harness commits in 30
days, 217 of them refactors; `rowVersions.ts` edited 34 times).

The design is eight moves. Six reshape TeXRA's kernel (M1 to M6). Two take a
shape from a peer and recast it as rows (M7 crash closers from dsh, M8 close
versus crash from pi-durable). It refuses, with the peers' own numbers, a task
scheduler, an event bus, YAML composition, documents as a second state owner,
deferred commits and JSONL. Together the moves delete about 1,250 kernel lines,
take a tool call from about 24 functions to about 8, liveness from 4 answers to
1, row readers outside reducers from 43 to 0, and warn-and-continue sites over
durable facts from 11 to 0, without a new concept, stored kind or layer.

## What gets deleted

| Move | What goes                                                                                                                                                                              | Count                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| M1   | The closure nest inside `dispatchPendingResponse` (`commit`, `commitResult`, `cardStart`, `resultCards`, `intentRow`, `skipCall`), `makeScheduler`, the `replan` read of `cell.opened` | about 210 lines                   |
| M2   | `executeAgent.ts` and `AgentRunLifecycle.ts` collapse (622 to about 150); `terminalResultToast.ts` and `buildFallbackNotification` leave the kernel                                    | about 595 kernel lines            |
| M3   | `RunEntry.hold`, `launches`, `activation.deciding`, `prune`, `drains`, `waiting` in `runRegistry.ts`; `LiveRun.live` and `launched`                                                    | about 200 lines                   |
| M4   | The 43 `row-readers-baseline` entries, the `rows()`/`display()` type filters, the 24-entry `IGNORED_ROW_TYPES` list in the run reducer                                                 | about 100 lines, 43 baseline rows |
| M5   | The `response`/`restoring` locals in `toolUse.ts`, `markResumeBlocked.retry`                                                                                                           | about 40 lines                    |
| M6   | 11 catch blocks that warn over a lost delivery, claim or accounting fact, and their three retry loops                                                                                  | about 120 lines                   |
| M7   | `sweepLeftoverRuns`' per-kind branches and `endInterrupted`, replaced by one closer function                                                                                           | net about 0; one site, not three  |
| M8   | Nothing; one payload field on `run.position`                                                                                                                                           | 0                                 |

The general-package design's own deletions (root exports 246 to about 30, about
1,650 app lines and about 1,400 duplicated host lines leaving the harness, the
tool-set layers of its lane 4b) stand beside these and are not counted again.

## Method

The criteria are John Ousterhout's (_A Philosophy of Software Design_, 2nd
ed.), each measured the same way on the three codebases:

| Criterion                      | Measured as                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Deep modules                   | lines behind a module's interface against the members of that interface; the deepest and shallowest named         |
| Information hiding             | facts known outside their owner: row or event type literals switched on outside the reducer, counted per codebase |
| Temporal decomposition         | modules split by when they run (init, run, finalize) rather than by what they know                                |
| Pass-through methods           | a method that forwards to one callee with the same signature                                                      |
| General-purpose core           | application vocabulary the kernel imports or special-cases, counted                                               |
| Define errors out of existence | fallbacks that mask a failure, against operations whose shape makes the failure unrepresentable                   |
| Pull complexity downward       | what an application author must do to run one conversation with one tool: calls, files, concepts                  |
| Design it twice                | whether the shape was chosen between recorded alternatives                                                        |
| Comments and names             | comments that restate code; names that mean something only with the planning docs open                            |
| Durability and ownership       | what is committed before what is shown; who may write; what a second process sees                                 |

Scores are 1 to 5 and are a reading aid; the evidence lines are the result.

## The three designs on one page

| Axis                       | TeXRA                                                                                                                                                                | pi-durable                                                                                                                                                                | dsh                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size                       | harness 84.6k lines, llm 12.0k                                                                                                                                       | 27.5k lines, a 6.4k-line spec                                                                                                                                             | 189k lines of TypeScript, kernel packages about 25k                                                                                                                  |
| Composition                | Effect layers at process, session and run lifetimes; plugins as typed values                                                                                         | `Harness.open(storage, { models, registry })`; extensions as in-process bundles                                                                                           | Cordis plugin tree from 97 base rows plus patches; 88 typed events in three domains                                                                                  |
| The loop                   | one program, `runToolUse` (431 lines) plus `dispatchPendingResponse` (804 lines, one function)                                                                       | scheduler (2,565 lines, 19 index structures) driving phase handlers; generation, tool and compaction tasks                                                                | `ReactLoopAgent`: 3 public methods over 2,130 lines; `turn()` 107 lines, `step()` 176                                                                                |
| State                      | `RunState` from rows (the resume authority); memory twins listed under M5                                                                                            | task rows plus the `pi.live` document plus the scheduler's `#live` mirror                                                                                                 | the log plus `deriveMessages()`; projection units with checkpoints; 4 in-memory facts in the driver                                                                  |
| Durability                 | five write points, one publisher, uninterruptible appends; stream chunks never rows                                                                                  | atomic commit, adopt before publish, deferred commits for partials, a failure latch; 15 storage transactions per turn with one tool                                       | synchronous emit into a 200 ms write-behind buffer, flushed fail-closed before every model call and tool body; fsync per batch, `link()` publication                 |
| Ownership across processes | a claim per aggregate, liveness from pid plus process start, `PRAGMA data_version` wake, a resume refused as `owned_elsewhere` unless the owner is proved dead       | none: "One process owns a storage at a time; there is no cross-process locking" (pi `README.md:881`); a second opener rewrites `running` tasks as `pending` and runs them | a non-expiring `flock` on `session.lock`; readers never blocked; `SessionOwnershipLostError` declared, never thrown                                                  |
| Extension unit             | `Plugin` (13 fields), `ITool` (11)                                                                                                                                   | `Extension` (6), `ToolRegistration` (12), `ToolExecutionApi` (23), 8 hooks                                                                                                | plugin contract with 17 touchable members; `ToolDefinition` (11); events                                                                                             |
| One tool, for an author    | an 11-line `defineTool` call, `attach({ approve })`, `tools` repeated on `resume`                                                                                    | 17 calls, 12 of them pi-durable's; a Chord `Context` on every call                                                                                                        | a 20-file package, about 29 files outside it, 130 snapshot files                                                                                                     |
| Crash recovery             | the same program over the rows; `nextAttempt` decides send, observe, reask, await, fail or cancel; a started call re-runs only when `replay` is `safe` on both sides | open rewrites `running` as `pending` with `restarts + 1`; a request found in flight is charged, not re-sent; tools re-run only when `replay` is `safe`                    | pure closers append a synthetic error `tool/result` per dangling call (`TOOL_NOT_STARTED` or `TOOL_OUTCOME_UNKNOWN`, with retry guidance) and `turn/end interrupted` |
| Retry bound                | counted from rows across crashes; a process-wide gate per route                                                                                                      | `maxRetries`, `restartLimit` 5, a fault for a phase that made no durable progress                                                                                         | none in the loop; `llm-retry` (5) and two compaction listeners each may claim the retry, in registration order                                                       |
| Churn                      | 372 harness commits in 30 days, 217 refactors; `rowVersions.ts` 34 edits                                                                                             | 9 releases in 20 days, 53 breaking entries; parking added in 1.4.0 and removed unreleased                                                                                 | 91 upgrade-guide entries over 11 pre-1.0 versions; 4 session-format bumps in 15 days                                                                                 |

## Findings by criterion

| Criterion                | TeXRA                                                                                                                                                                                         | pi-durable                                                                                                                                           | dsh                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deep modules             | 3: `Sessions` (4 members over 1,417 lines), the reducers and `rowCodec` are deep; the loop is a deep door over one 804-line function; five tool-set layers; `SessionHandle` named in 63 files | 3: scheduler, session, transaction and context deep; `live.ts` 26 exports over 451 lines; `TaskRuntime` 35 members, `Tx` 17 methods in 29 signatures | 3: loop and `tools.execute` (1 line over 1,056) deep; `AgentRegistry` 15, `ctx.llm` 16 (7 forwards), `Session` 19; two 1:1 mirror ports (fs 16, jobs 9)          |
| Information hiding       | 3: 43 reader entries over 15 row types (6 outside the harness); `session.log` in 30 files; `RunState` fields read in 17 files; the view read as state at 15 sites                             | 2: read-before-write, line holding and the `pi.live` layout leak to every author (46 documented footguns; 20 `LiveDoc` sites in one file)            | 3: `ReactLoopAgent` private; persistence obligations in JSDoc prose; `run_code` and LLM shapes known to general registries                                       |
| One owner per fact       | 3: liveness has four readers; `run.config` three producers; grants three sources; six memory twins                                                                                            | 2: busy, tool-slot status and compaction status in `pi.live` and in task rows; submissions finished from four files                                  | 2: four owners of the next sequence number; the header serialized three ways; retry counts in a projection and a `WeakMap`; default sandbox mode in four places  |
| Errors out of existence  | 3: derived request ids, `tool.intent`, the store gate and a typed `RunHistoryInconsistent` are definitional; 11 warn-and-continue sites remain                                                | 3: atomic commit and durable abort marks define states away; `ReadAfterWrite`, in-commit hangs and no-progress faults are handled                    | 3: `seq = log.length`, data-decided turn stop, closers; `NO_ADAPTER` caught and bypassed, an absent approval becomes a denial string, 45 coverage-ignore markers |
| General-purpose core     | 3: zero app imports, zero LaTeX terms; `AgentConfig` carries 11 app fields; `recipe` in 27 files; editor-named events on `SessionHost`; final-tool nudges in the loop                         | 3: the kernel is domain-free; the Harness refuses a registry without its three `pi.*` tasks                                                          | 2: `x-deepseek-harness-*` transport metadata, `in-history`, `LlmFailure.offloadImages`, `SessionHeader.agentPreset`, `run_code` reserved in the registry         |
| Pull complexity down     | 3: `defineTool`, `RunCell.append` and `nextAttempt` pull it down; `InvocationDriver` (10 callbacks) and three child strategies push it up                                                     | 3: recovery, cascades and holds below; idempotency keys, phase splitting and memo prefixes pushed onto authors                                       | 4: result recording, repair, framing, lease and migration inside their owners; 18 pre-step listeners must spread a decision correctly                            |
| Author's cost            | 2: 25 program lines for one run; `tools` repeated on `resume`; a built-in needs `RunCall`, `ChildRuns` and `Runs`; `host.ts` has 87 export statements                                         | 3: 12 calls for one conversation, 17 with one tool; the answer is read inside a commit callback                                                      | 3: 3 calls for one conversation through the SDK; one custom tool is a package plus a patch plus an install                                                       |
| Design it twice          | 4: the general-package design scored four alternatives; `refuted-candidates.json` pins refused shapes with their evidence                                                                     | 2: the spec records rules, the changelog records reversals (parking, resend-on-crash, progress cadence) within 20 days                               | 3: upgrade guides record each break; two HMR implementations and a deprecated hook still dispatched                                                              |
| Comments and names       | 3: 19 issue or commit citations in code; `settle` on 184 lines, `park` 72, `fold` 125, `admit` 94, against the plain-names table                                                              | 4: comments say why; `REMINDER:` blocks cite spec section numbers                                                                                    | 3: load-bearing rules explained only in planning notes; docs name a persistence method and a patch form that do not exist                                        |
| Durability and ownership | 5                                                                                                                                                                                             | 5 within one process, 1 across processes                                                                                                             | 4: no attempt row before the response is recorded; jobs and subagent activations are process maps forgotten after a crash                                        |

Three findings decide the design.

**The call path.** All three put the model-to-tool round trip in one place, and
only TeXRA's is one function: `dispatchPendingResponse` is lines 304 to 1107 of
`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts`, with `execute`,
`scriptDoor` and `responseCall` nested inside it and a 75-line barrier scheduler
(`makeScheduler`, 225 to 299) built from three `Deferred` maps, a `Ref` and a
`Semaphore`. One call passes about 24 named functions in 14 files between the
`response` row and its `tool.result` row. dsh's pipeline is three waterfalls and
a batch scheduler in two files behind `execute()`; pi's is `ToolTask.call` then
`settle`. The depth is right at the door and wrong inside.

**Time, not knowledge.** TeXRA's run start and end are spread across
`rootLaunch.ts`, `AgentLaunchContext.ts`, `executeAgent.ts`, `runProgram.ts`,
`AgentRunLifecycle.ts`, `agent/storage/runLifecycle.ts`,
`terminalResultToast.ts`, `sessionDescription.ts`, `runLaunchGuard.ts` and
`resumeRun.ts` (2,668 lines), with `run.end` reached through `endIn` from four
paths. `rowVersions.ts` and `runLifecycle.ts` were edited 34 and 30 times in 30
days: the cost of change amplification. pi's lifecycle sits in the scheduler
and dsh's in one 192-line `initializeAgent`; neither is split by phase.

**Second owners.** All three keep a live mirror beside the durable record, and
each pays for it: pi's `pi.live` diverges from the task tree after an answer
with `afterRun` hooks; dsh's turn counter and its `turnBoundary` projection both
own "current turn"; TeXRA answers "who runs this run" from `RunRegistry.isLive`
(`runRegistry.ts:251`), `SessionLog.owns` (`SessionHandle.ts:154`),
`RunView.ownerId` with `LocalRuntimeState.dead`, and `ProcessIdentity.owners`;
`decideResume` (`resumeRun.ts:157-210`) asks the registry, then the claim,
then the owning call, and the hosts read the view's pair. The claim row
already is the owner on disk; the other three are caches that can disagree.

## What the peers show, and what is refused

Taken, reshaped as rows (M7, M8):

- **Crash repair as a pure function over the log** (dsh
  `packages/core/session/src/repair.ts:14-98`). On resume, a total function
  over the persisted events emits the rows that close every dangling fact: an
  error `tool/result` per unanswered call, naming whether the body started,
  with text that tells the model to retry only idempotent work, then
  `step/end` and `turn/end { kind: 'interrupted' }`. TeXRA has half of this:
  the replay rule and "outcome unknown" exist for calls of the resumed run, but
  work the run owned and did not await is closed by three separate sites
  (`sweepLeftoverRuns`, `endInterrupted` from #14424, the `openOwnedChildren`
  cascade), and background agent and script children are never woken and their
  parent is never told. One closer function is the shape.
- **Close against crash** (pi `src/harness/scheduler.ts:400-404` and spec
  §5.1). A clean close writes a task back as `pending` without a count; a crash
  is found at open and charged (`restarts + 1`, the in-flight request treated as
  a failed attempt). TeXRA charges a crash-cut attempt since #14423 but cannot
  tell a close from a crash (#14412), so a clean shutdown spends a retry it did
  not use.

Evaluated and not taken, with the evidence:

| Peer shape                                                       | Why not                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A task scheduler (pi)                                            | 2,565 lines, 19 index structures, a 12 s to 50 ms fix eleven days after 1.0, parking added and removed within 20 days; AGENTS.md rules out a flow engine. One program per run already gives one owner of loop state.                 |
| An event bus with listener order (dsh)                           | 88 events; `agent/request-error` has three listeners that may each claim the retry, so recovery depends on registration order; 18 `agent/pre-step` listeners each able to rewrite messages. Invariant 6: no ordered listener chains. |
| Composition from YAML patches (dsh)                              | one 81-line guard touches about 29 files; `config` replaced whole, never merged; a documented `preset` patch form with no handler. Effect layers and `Plugin` values already compose at build time with types.                       |
| Documents as a second state owner (pi `pi.live`)                 | busy, tool slots and compaction status live twice and diverge; `defineDoc` was dropped on 2026-10-02 (durable-harness note).                                                                                                         |
| Deferred commits for streamed progress (pi)                      | TeXRA writes no progress rows: stream chunks are transient on the live trace (invariant 9), so there is nothing to defer; pi's consumer invariant is maintained by hand in each consumer.                                            |
| The exact stream embedded in the assistant row (dsh)             | TeXRA stores the final message and each attempt as rows already; embedding every timed chunk would move transient observations into history against invariant 9 and grow rows by the stream size.                                    |
| Projection units with checkpoint rows (dsh)                      | the two named projections and `projection_state` already rebuild from rows; a stored derivation beside the rows was deleted in #13837, and invariant 2 allows only a checkpoint that loses every conflict.                           |
| JSONL with `flock` (dsh), five storage backends (pi)             | one SQLite backend on purpose (durable-harness note, "Considered and dropped"); claims with liveness need a store that can refuse a writer, which a file lock without expiry and a per-process id counter cannot.                    |
| Step-scoped tool resolution, once per step (dsh `tools.resolve`) | the right shape, and TeXRA's `StepTools` already pins the set per step; what is wrong is the five layers around it, which the general-package design's lane 4b collapses. Not a new move.                                            |

## The design

Each move names the criterion it serves, the shape (marked illustrative where
it is an API sketch), what it deletes and what it risks. None adds a stored
kind, a service, a layer or a concept.

### M1. One per-call program

Criterion: deep modules; pull complexity downward.

Shape (illustrative): a `finishCall(cell, call: PendingCall, place)` module
whose only input is the row-derived `PendingCall` and whose only output is the
`tool.result` batch, used by the response path and by the script guest alike.
The scheduler becomes a pure partition of the response's calls into
`[barrier | parallel[]]` groups run with `Effect.forEach({ concurrency: 4 })`;
the script guest keeps its `seq` order from the `script.call` rows it already
holds. The write points do not move: `tool.intent` as the body starts,
`tool.result` before the loop continues, delivery in one batch.

Deletes: the six closures, `makeScheduler`, the `replan` read of `cell.opened`
(about 210 lines); the function count per call from about 24 to about 8.

Risk: the interleaving of guest calls with response calls under one `seq`, and
the rule that nothing runs until the guest holds everything already finished
(`toolUseDispatch.ts:285-286`). The crash-point suite covers both.

### M2. One run module, grouped by what it knows

Criterion: temporal decomposition; change amplification.

Shape (illustrative): `run.ts` with `launch`, `resume` and `end`, each holding
everything about its decision; the registration, activation and end rows beside
their readers in `shared/session/runFacts.ts`; the editor notice and the toast
moved to a host that reads `run.end` from the view. `executeAgent` is inlined
into the entry point, as AGENTS.md already asks for a wrapper that only creates
state, runs a program and interprets results.

Deletes: `executeAgent.ts` (205) and `AgentRunLifecycle.ts` (417) to about 150
lines; `terminalResultToast.ts` (107) and `buildFallbackNotification` (18) leave
the kernel.

Relation: the tech-debt note's §1 owns the lifecycle order (activation opened at
`launch` and `resume`, an SDK `Run` as a view over the session). This move is
the layout that order lands in, not a second order.

Risk: the crash-point suite's commit points move with the code; the `onAdmitted`
ordering in `executeAgent.ts:80-89`.

### M3. The claim is the only owner of "who runs this run"

Criterion: one owner per fact; information hiding.

Shape (illustrative): the claim row is the owner; the registry is a
`FiberMap<RunId>` plus the per-key lane the refuted
`EFF-ADOPT-per-key-lane-semaphore` entry keeps; "live here" means "has a
fiber"; `RunView.ownerId` and the process's verdict map are projections of the
claim and of liveness, never consulted for a decision (invariant 3).
`decideResume` asks the claim once.

Deletes: `RunEntry.hold`, `launches`, `activation.deciding`, `prune`, `drains`,
`waiting` (about 200 of `runRegistry.ts`'s 825 lines); `LiveRun.live` and
`launched`.

Risk: the start race the lane was kept for (2 of 2,101 in the refuted entry's
measurement); keep the lane, delete the counters.

### M4. Rows stay behind their reducers

Criterion: information hiding.

Shape (illustrative): `SessionLog` narrows to `transact`, `publish` and fact
reads (`facts(runId)` exists, `SessionHandle.ts:127`); each of the 43 baseline
readers becomes a reducer output (`RunFacts.start`, `RunFacts.removed`), and
`rows(id, types)` goes. Display rows stop reaching the run reducer, so the
24-entry ignore list goes with them.

Deletes: the 43 `row-readers-baseline` rows (the ratchet's stated goal), the
`rows()`/`display()` type filters, `IGNORED_ROW_TYPES`.

Risk: cold listing reads that filter by type in SQL today (`READ_LISTING`,
`rowReader.ts:75`) keep their query; only in-process readers change.

### M5. In-flight facts have one home

Criterion: one owner per fact; define errors out of existence.

Six facts live in memory beside their row: the turn's `response`
(`toolUse.ts:163`, re-derived from the last assistant message on resume at
401-406), `AgentRun.model` beside `run.config`, `toolEdits` beside
`request.opened`, `resumeBlocked.retry`, the `ChildLoop` counters beside
`child.turn`, and `activation.stop` beside `run.position halted`.

Shape: derive `response` from the rows on both paths, as resume already does;
store a proposal's content and the person's edit of it as a `context.blob` by
digest beside its request (the blob table exists, `storeSchema.ts:66-69`), so
a crash keeps the edit; record a stop as the `run.position halted` row it
becomes; `resumeBlocked` stays process-local (it is a fact about this process's
catalog) and loses `retry`, an intention that dies with the process.

Deletes: the `restoring` flag and about 40 lines of locals; the second write
path for `response`.

Risk: blob growth for large diffs; the `request.opened` payload gains a digest
(a row-version bump, free before the freeze).

### M6. A lost durable fact is a row or a failure, never a warning

Criterion: define errors out of existence; silent degradation is a defect.

Eleven sites beyond the eight in `silent-degradation.json` warn and continue
over a durable fact: a request its call no longer asks stays open
(`toolGuard.ts:305-315`); a child's launch failure never reaches its parent
(`childTurnResult.ts:341-358`); held results are dropped after 20 tries
(`runLaunchGuard.ts:217-226`); a claim not released stays held until the
process dies (`runRegistry.ts:502-505`); a finished compaction's paid summary
is dropped at stop (`toolUse.ts:553-560`); a request's cancel is not written as
the run stops (`requestPolicy.ts:362-372`); usage accounting is lost
(`run/pricing.ts:118-126`); and four more in `sessionTools.ts`,
`interruptedTasks.ts`, `Database.ts:1020` and the media path.

Shape: a failed retirement or delivery becomes a row the next acceptance reads
(`child.park` already is this for held results; the launch-failure path uses
it); a claim-release failure is a `DatabaseWriteFailed` that ends the run like
any refused write (`findStorageRefusal` exists); a usage write failure is a flag
on the `usage` row.

Deletes: 11 catch blocks (about 120 lines) and three retry loops.

Risk: failures that scroll by as warnings today end the run visibly.

### M7. One closer for everything a dead process left open

Criterion: define errors out of existence; general over special.

Shape (illustrative): `closers(facts: RunFacts, owned: readonly ChildFacts[]):
readonly Draft[]`, a total function over a run's rows and the rows of the
children its open calls own, run inside the resume batch through the same
`RunCell.append`. It yields, per dangling fact, the row that closes it: a
started call with no result becomes `outcome unknown` or is re-run under the
replay rule (unchanged); an awaited child with no end is cancelled (unchanged,
today's `beforeEnd` cascade); a background child, agent or script, with no end
and no live owner gets a `followup.queued` on its parent that says the work
was interrupted and its outcome is unknown, the shape #14424 gave background
shells; a child that is itself resumable is resumed by its parent's resume,
not by the open-time follower, which keeps resuming roots only.

Replaces: the three sites that close leftovers today (`sweepLeftoverRuns`'
per-kind branches, `endInterrupted`, the cascade), and closes the open gap
from the Pi Durable study: background agent and script children stranded by a
crash with a parent that is never told.

Risk: a closer that re-runs a replay-safe child must not race the child's own
resume; the claim decides (M3).

### M8. A clean close is not a crash

Criterion: define errors out of existence.

Shape: the session close protocol (invariant 10) already stops acceptance,
drains deliveries and finishes runs within `SESSION_CLOSE_DEADLINE_MS`. A run
it interrupts writes `run.position halted { reason: 'closed' }` (a payload
value on an existing kind). `nextAttempt` reads it: an attempt cut by a close
is not spent, an attempt cut by anything else is, as #14423 made it. The same
field tells `closers` (M7) that owned work was stopped, not lost.

Deletes: nothing. Adds one optional payload field (`reason`) to an existing
kind.

Risk: a close that overruns its deadline is interrupted and leaves no `halted`
row, which then reads as a crash. That is the correct reading.

### Already designed elsewhere

Two of the problems the passes ranked are the general-package design's lanes
and are not redesigned here:

- **The host door and app vocabulary on the SDK surface** (`host.ts` 87 export
  statements; `SessionHost` carrying five editor-named events; `AgentConfig`
  with 11 app fields; `tools` repeated on `resume`; `TeamPlan` and
  `WorkspaceAgentsController` in the package): lanes 1 and 3 of that design.
- **Five tool-set layers and two tool contracts** (`ToolRegistry` to
  `ToolCatalog` to `SessionTools` to `StepTools` to `RuntimeToolRegistry`;
  `ITool` against `RuntimeTool`, `ToolContext` against `RunCall`, `definePlugin`
  against `defineBuiltinPlugin`): its lane 4b, which dsh's single `resolve()`
  confirms as the target shape.

### Sequencing

1. M8 first: it is the one stored-shape change and must land before the
   storage freeze; M7 lands with it, because the closer reads the `closed`
   reason.
2. M3 before M2: with one owner of liveness, the lifecycle module has one
   question fewer to answer, and the tech-debt note's §1 order lands in it.
3. M1 is independent of the others and can go at any time.
4. M4 after M2: the lifecycle rows move beside their reducer first, which
   removes most of the readers M4 then closes.
5. M5 and M6 at any time, one PR each.

Each move is one PR with a negative net line count and no new test file; the
crash-point suite, the golden store and the ratchets are the gate. A move that
cannot be made net-negative is reported, not forced.

## Decided questions this review does not reopen

Each was ruled or refuted with evidence; a peer doing it differently is not new
evidence. Reopening one needs the trigger its ruling names.

- A flow engine, task scheduler, cursor or services bag in the run loop
  (`AGENTS.md`, "Agent system").
- A stored run-state snapshot beside the rows (deleted in #13837; invariant 2 of
  the [core concepts](./2026-09-26-core-concepts.md)
  allows only a checkpoint that rows rebuild and that loses every conflict).
- `defineDoc`-style plugin documents, a same-path edit queue, an effect class
  replacing `replay`, a second storage backend, in-process hooks as Effect
  values, a daemon for auto-continue
  ([durable harness](./2026-10-02-durable-harness.md),
  "Considered and dropped").
- Effect's `McpClient`, `CircuitBreaker` for the retry gate, `Semaphore` for
  `withPerKeyLane`, `ConfigProvider` for settings
  (`config/ratchets/refuted-candidates.json`, the `EFF-ADOPT-*` entries).
- Typed RPC, `History.writer` and an open schema registry wait for a named
  plugin that cannot be MCP plus hooks plus data (rulings ledger, 2026-09-30;
  D11).

## Owner decisions

Answered 2026-10-30: yes to all five. Decision 2 landed with one qualification, recorded under "Landed": a pending edit is durable from Approve, and an edit in progress stays the editor's buffer.

1. **M8.** Record a clean close as `run.position halted { reason: 'closed' }`,
   one optional field on an existing kind, before the storage freeze? _Recommend:
   yes._
2. **M5.** Store a proposal's content and the person's edit as a `context.blob`
   beside its `request.opened`, so a crash keeps the edit? The alternative keeps
   it in memory and accepts the loss. _Recommend: yes; the blob table exists._
3. **M6.** Accept that a failed claim release, held-result delivery or usage
   write ends the run or lands as a row, where today a warning scrolls by?
   _Recommend: yes._
4. **M3.** The claim row as the only owner, with the registry reduced to a
   `FiberMap` and the per-key lane? _Recommend: yes._
5. **M5.** `resumeBlocked` stays process-local and loses `retry`? _Recommend:
   yes._

## Landed (2026-10-30)

All eight moves merged on 2026-10-30, each verified on the merged tree
(typecheck, the crash-point suite, `test:changed`) before merging.

| Move   | PR     | What landed                                                                                                                                                                                                                                                                                                                                                                                                       | Kernel lines       |
| ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| M3     | #14444 | The claim row is the one owner of liveness and the registry holding an activation is the one in-process predicate; `RunEntry.hold`, `launches`, `deciding`, `prune`, `drains`, `waiting`, `LiveRun.live` and `launched` deleted; `runRegistry.ts` 825 to 700 lines.                                                                                                                                               | −127               |
| M7, M8 | #14445 | `run.position halted` gains `reason: 'closed'`, and an attempt cut by a clean close spends no retry. `closeLeftoverChildren` runs on every resume and resumes or reports every child a dead process left; `endInterrupted` and the shell sweep's per-kind branches deleted. The crash suite gained the failure mode and failed first.                                                                             | +88 (new behavior) |
| M1     | #14446 | One per-call program, `finishCall`, shared by the response path and the script guest; a pure partition run with `Effect.forEach({ concurrency: 4 })` replaces `makeScheduler`; functions on the call path in the file 11 to 7.                                                                                                                                                                                    | −7                 |
| M2     | #14450 | `executeAgent.ts` is the run program and `AgentRunLifecycle.ts` the end (`endRun`, `endActivation`, `finalizeRun`, `endIn`); the lifecycle rows sit beside their readers in `runFacts.ts`; `terminalResultToast.ts` deleted and the editor notice left the kernel; the ten modules 2,803 to 2,536 lines.                                                                                                          | −61                |
| M4     | #14453 | `SessionLog.rows` became `history` and `runRows` over named reads; `IGNORED_ROW_TYPES` deleted; the row-readers baseline 43 to 14 (the store codec, the one writer's preconditions, the trace boundary and the trace viewer remain).                                                                                                                                                                              | −32                |
| M5     | #14451 | The turn's `response` is derived from rows on both paths (`RunState.resuming` replaces `restoring`); the model identity is read from `run.config`; a tool-edit proposal is stored as a blob beside `request.opened` and the person's edit as `request.decided.content`; `toolEdits`, `request.edit`, the staged-edit store and the window hand-off deleted; `resumeBlocked` carries no `retry`.                   | −80                |
| M6     | #14473 | Nine of the eleven sites became a row, a typed failure or a shape that cannot fail silently (a request the run leaves open is cancelled in its end batch; a held result's `child.park` releases the child's claim; a claim a run cannot hold fails it; skipped media is a text part of the stored message); two stay as review-checklist §15 exceptions (the follower's per-run fan-out, the store's busy probe). | −41                |

The estimates in "What gets deleted" counted lines that moved as lines that
vanished: M1 and M2 landed far below them, and M7 added behavior. The
structural goals held: no closure nest, one run module, one owner of liveness,
no row kind named outside its reducer, no memory twin, no warning over a lost
durable fact.

## Verified

- The three passes' notes, with file and line evidence, are committed beside
  this note in
  `.agents/docs/evidence/2026-10-30-harness-design-against-pi-durable-and-deepseek/`
  (`pi-durable.md`, `deepseek.md`, `texra.md`); each pass spot-checked its own
  anchors after drafting. The peer trees are not vendored: pi at `31ade0e0`
  and dsh at `ce7073d5` are public repositories on GitHub.
- Checked by the author against the tree at `808521a8ed`:
  `dispatchPendingResponse` starts at `toolUseDispatch.ts:304` and
  `makeScheduler` at 225 in a 1,107-line file; the ten lifecycle modules total
  2,668 lines (`runProgram.ts` is under `agent/runtime/loop/`);
  `RunRegistry.isLive` at `runRegistry.ts:251` and `SessionLog.owns` at
  `SessionHandle.ts:154`; 15 `SubscriptionRef.getUnsafe(…view…)` sites in 14
  files; `row-readers-baseline.json` has 15 types, 43 entries, 6 outside the
  harness; `git log --since=30.days`: 711 commits at the time of the count (a
  day-boundary figure; the harness counts are exact), 372 touching
  `packages/harness`, 28 `fix(harness)`, 217 `refactor`, `rowVersions.ts`
  changed 34 times; the warn sites at `toolGuard.ts:305-315` and
  `runLaunchGuard.ts:217-226` read as described.
- Checked against the peers: pi's `src/` (tests excluded) contains no `flock`,
  `lease`, `hostname`, `heartbeat` or `process.pid`, and `README.md:881` states
  the one-process rule; `scheduler.ts:400-404` rewrites `running` as `pending`
  with `restarts + 1`; dsh's `tool-todo` package is 20 files, `todo_write`
  appears in 130 snapshot files, and its base row is at
  `bundle/base/cordis.patch.yml:436`.
- Not run: no build, test or benchmark on either peer; pi's "15 storage
  transactions per turn" is the pass's count from the code paths, not a
  measurement.
