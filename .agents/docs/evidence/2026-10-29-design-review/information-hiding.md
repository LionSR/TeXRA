# Information hiding, leakage, and temporal decomposition (APSD ch. 5, 7-8)

Revisions: TeXRA `cae1afc30a` (paths under `packages/harness/src` unless stated), pi `c3d8ce4` (`packages/durable/src`), DeepSeek `f3803c96` (`packages/`; rich profile unless stated). All counts are `grep` over production `.ts` files, with tests, `vitest`, `dist` and generated API catalogs excluded, unless another method is named.

## 1. Verdict

pi hides the most lifecycle decisions. A submission is a typed state machine whose transitions one transaction method enforces. A stop is a durable mark plus a per-kind abort handler. Every input of a run is settled in one function. DeepSeek hides individual policies well: approval, checkpoint ordering, the cancel cause and the session lease each sit in one plugin. Its persisted event format, though, is the integration interface for dozens of packages. TeXRA is in between. Its row format is hidden better than either peer's, and a ratchet enforces that, but stop meaning, the claim protocol and the meaning of `followup.consumed` still leak into 4 to 7 files each.

Grades: **pi A-**: submissions, abort and run end each have one owner; the cost is task fields known to four storage backends and failure reasons stated twice. **TeXRA B**: reducers and the `run.end` constructor are owned and ratcheted; stop precedence, `{ends: true}` claim handling and consume semantics are not. **DeepSeek C+**: approval and checkpoint policy are textbook deep modules; core events are read raw in 30 to 39 packages, and the policy row is written past its own setter.

## 2. Findings

### TeXRA

**+ Row format behind reducers, enforced (deep module, information hiding).** `src/test-kernel/architecture/factOwnerRatchet.vitest.ts:51-70` names 6 reducer files and 2 vocabulary files. `config/ratchets/row-readers-baseline.json` lists what still leaks: 43 (type, file) entries over 31 distinct files and 15 row types. Counted with `python3 -c "import json; d=json.load(open(...))['readers']; ..."`. The leak is concentrated: `plugin.fact` has 7 readers, `run.start` 8 and `run.removed` 6. With the same raw-literal grep used for DeepSeek, `'tool.result'` appears in 16 TeXRA files and `'run.end'` in 12, including constructors and reducers. Neither peer has a mechanical owner check.

**+ One constructor of the terminal row.** `agent/storage/runLifecycle.ts:220-290` (`endIn`) is the only builder of `run.end`, and `factOwnerRatchet.vitest.ts:96-104` pins it there. `agent/runtime/runRegistry.ts:660-679` (`stopEnd`, #14411) is the one place that decides the end of a run no generation drove.

**- Stop meaning leaks (information leakage, overexposure).** The reason for a stop lives on the activation (`runRegistry.ts:122`, `markStopped` :697). It is then published on the public `LiveRun.stopReason` (`agent/runtime/runs.ts:57`). Four files read it and each decides a consequence:

- `childRunLoop.ts:671`: a `user` stop sends the parent a notice.
- `childRunLoop.ts:705`: any stop means cancelled.
- `run/backgroundTurn.ts:99`: a `user` stop cancels the provider job.
- `followUp/ToolUseFollowUp.ts:298`: any stop means wait for the run to drain.

The precedence rule "a stop outranks the run's own report" is written in five files: `shared/runs/runStatus.ts:31-35` (`outcomeFromCause`), `AgentRunLifecycle.ts:109,128,293,366-370`, `childRunLoop.ts:704-710`, `runLifecycle.ts:339` and `agent/runtime/loop/toolUse.ts:451`. Ten harness files construct or derive `CANCELLED` (grep `outcomeFromCause|RUN_OUTCOME.CANCELLED`).

**- The end is decided in layers ordered by time (temporal decomposition, change amplification).** Three layers each re-derive the outcome:

- `endActivation` (`AgentRunLifecycle.ts:97-178`) ends the stage, builds a `ResultEvent`, then calls `finalizeRun`.
- `finalizeRun` (`runLifecycle.ts:323-396`) cascades to children, applies the lost-trace rule, writes, and falls back to a backstop.
- `endIn` (`runLifecycle.ts:220-290`) writes the row.

The rule "a lost trace row makes the run FAILED unless it was stopped" is computed twice, at `AgentRunLifecycle.ts:124-128` and `runLifecycle.ts:338-339`. That happens because `finalizeRun` returns only `{ recorded }` (:217-219), so its caller rebuilds the outcome it just persisted. `runLaunchGuard.ts:202` calls `endIn` directly, which skips `finalizeRun`'s lost-trace and owned-children checks (inferred consequence; not traced end to end).

**- Claim protocol spread across callers (information leakage).**

- `session.log.hold(` has 13 call sites in 7 files.
- The "hold, write an end, let go" sequence (`{ ends: true }`) is repeated at 6 sites in 5 files: `forkRun.ts:222`, `runLaunchGuard.ts:45`, `runRegistry.ts:497,656,674` and `runLifecycle.ts:309`.
- The fact "another process holds the run" has three representations: the errors `DatabaseNotOwner`/`DatabaseClaimRefused`; the predicate `heldElsewhereBy` (`shared/session/database.ts:146`, exported to hosts at `host.ts:93`); and the string `'owned_elsewhere'` in two different result types (`followUp/Inbox.ts:81`, `resumeRun.ts:252`).
- The CLI interprets the raw form twice: `packages/cli/src/chat/chatSessionController.ts:422` and `packages/cli/src/runtime/executeCli.ts:559-566`.

**- `followup.consumed` carries no disposition (information leakage into context).** The row is `{ followUpId }` only (`shared/schemas/sessionEvent.ts:298-300`). It is written at 8 sites in 7 files, with at least five meanings:

- incorporated into a turn: `FollowUps.ts:259`;
- a stale notice dropped: `childTurnResult.ts:154`;
- input closed while unread: `Inbox.ts:228-231`;
- answered by a tool: `loop/toolUseDispatch.ts:677`;
- a control applied or swept at the end: `loop/modelSwitch.ts:38`, `loop/toolUse.ts:356,367`, `runLifecycle.ts:253`.

A reader that wants a receipt must reconstruct the meaning from the co-committed rows. Sending a message returns `duplicate | queued | refused` (`Inbox.ts:77-80`), which has no relation to an answer.

**- `runLaunchGuard.ts` is named for a time, not for knowledge (temporal decomposition).** Its header (lines 1-5) defines it as "the ends a run's driver does not write". It joins two unrelated things:

- the failed process-child hand-off (`runWithLaunchGuard`, :58-112, whose only caller is `delegation/detachedChildRun.ts:78`);
- the whole held-result delivery protocol: `deliverHeld`, `deliverOne`, `onHeldResult` and `clearHeld` (:114-282).

That protocol's `child.park`/`heldFor` writers sit elsewhere (`childTurnResult.ts:250-253`, `delegation/childRun.ts:106`, `childRunLoop.ts:369`), and its triggers live in `sessionLayer.ts:249` and `resumeRun.ts:194`. Knowing how a held result is delivered takes six files.

**- Approval inputs gathered by each caller (ALREADY QUEUED, row 5, #14413).** The pure rules are centralized (`shared/approvalPolicy.ts:62-185`), but their inputs are assembled separately:

- `approvals.policy(` appears in 4 files (`bashApproval.ts:94`, `toolEditApproval.ts:156`, `requestPolicy.ts:81,107,201`, `proposalFlow.ts:155`);
- `approvals.bypass(` has 7 sites;
- `approvalPromptsUnavailable` is read in 10 harness files;
- `approvalDenied(` is reported from 5 files.

### pi

**+ Submission lifecycle is one state machine (deep module, define errors out of existence).** `types.ts:495-590` gives each submission a status (`queued`, `placed`, `done`, `unanswered`) and a typed reason. `session/transaction.ts:64-80` (`applySubmissionChange`) makes those transitions monotonic: a settled record stays. A run's end settles every input it incorporated in one function, `endRun` (`harness/live.ts:268-288`). The "many inputs, one answer" rule therefore lives in one place.

**+ Stop is a durable mark plus a per-kind handler.** The scheduler alone sets `abortRequested` (`harness/scheduler.ts:531-549`, cascade :780-795). Each task kind must implement `abort`, which commits a terminal outcome (`types.ts:364-365`). Progress from a marked task is refused at the transaction (`session/transaction.ts:1013`). Closing the harness aborts invocations without marking them, so the work stays recoverable. Callers never interpret why a task stopped.

**- Task record fields are known to the storage backends (information leakage).** Task `state.status` and `abortRequested` are indexed or filtered by `storage/sqlite/storage.ts:458-460,832`, `storage/memory.ts:564` and `storage/indexeddb.ts`. A task-state change touches four backends.

**- Each failure reason is stated twice (conjoined code).** In `harness/generation.ts`, each of about 9 terminal sites both calls `endRun` with a submission reason and returns a task outcome naming the same reason (for example :357-358 and :432-436). `harness/live.ts:395-420` then maps task outcomes back onto submissions as a fallback. Inside the scheduler, the abort-mark subtlety `abortReason === undefined` recurs 13 times.

pi durable has no cross-process claim and no human approval. Its single tool decision is the `beforeTool` chain at `harness/tool.ts:161-171`, which can block or rewrite arguments before intent. It is not a comparable approval owner.

### DeepSeek

**+ Approval policy is fully hidden (deep module).** `interaction/user-approval/src/index.ts:89-121` has its own projection and setter. `ApprovalService` applies the policy once, inside `ask` (:270-301). Tools never read the policy: they reach it through the one `tools/pre-execute` waterfall in `core/tools/src/pipeline.ts:190-230`, with arguments frozen first (:157).

**+ The cancel cause is data carried to one writer.** `cancel(cause)` (`core/agent-loop/src/agent.ts:191-196`) aborts with a typed `AgentCancelCause` (`core/session/src/types.ts:194-201`). The loop's `finally` is the only writer of `turn/end`, and it records `{ kind: 'aborted', reason: cause }` (`agent.ts:403-406,422`). Outside the loop, only three sites read the cause, and all ask the same question: `disposed` or not.

**+ Checkpoint ordering and the lease are each in one module (pull complexity down).** All durability ordering is an 83-line plugin (`session/session-checkpoint-policy/src/index.ts:63-83`). The cross-process lease is `session/session-persistence-jsonl/src/lease.ts:1-28`. Its one error, `SessionAlreadyOwnedError`, has a single consumer outside persistence (`api/session-controller/src/agent.ts`).

**- The raw event format is the integration interface (information leakage, change amplification).** Using the same literal grep counted per package:

| Event               | Packages that name it | Files that name it |
| ------------------- | --------------------- | ------------------ |
| `turn/end`          | 39                    | 60                 |
| `assistant/message` | 34                    | not counted        |
| `user/message`      | 33                    | 62                 |
| `tool/result`       | 33                    | 59                 |

Four of those packages are format migrations (`session-format-v0-to-v1` through `v3-to-v4`). Declaration merging gives each package its own event types, but no projection boundary stops other packages from reading the core events.

**- The policy row is written past its setter.** `user-approval` calls `setApprovalPolicy` "the sole durable representation" (:112-121), yet `subagent/subagent/src/child-agent.ts:274` appends `approval/policy` directly. A second projection folds the same event (`interaction/permission-presets/src/index.ts:137`).

**- The inbox splice has no disposition.** The `agent/inbox/spliced` fold (`core/agent-loop/src/inbox.ts:26-57`) records removals with no reason, which is the same gap TeXRA's `followup.consumed` has. 15 packages read that event.

## 3. What TeXRA should do

Ranked by how much decided-elsewhere knowledge each change removes.

**1. Decide stop precedence once, from the cause.** _Red flag:_ information leakage and change amplification (5 copies of the precedence rule; 4 files reading `stopReason`).

- _Change:_ `endActivation` and `childRunLoop.writeEnd` take the exit cause and the activation's stop reason, and `outcomeFromCause` (`runStatus.ts:27`) becomes the only precedence function.
- Delete the `stopped` parameter and its branches in `AgentRunLifecycle.ts:76-78,104-110,126-129,293,366-370` and `childRunLoop.ts:704-710`.
- Remove `stopReason` from the public `LiveRun` (`runs.ts:56-57`). Expose `runs.stoppedByUser(runId)` to the three readers that need the `user` case (`childRunLoop.ts:671`, `backgroundTurn.ts:99`, `ToolUseFollowUp.ts:298`).
- _Estimate:_ -30 to -40 lines, counted from the cited ranges.
- _Peer:_ DeepSeek writes the cause into the one `turn/end` writer (`agent.ts:403-422`); pi lets no caller interpret a stop (`types.ts:364`).
- _Status:_ ALREADY QUEUED (row 4, "one decision for how a run ends").

**2. Let the end writer own the claim it needs, and give "held elsewhere" one representation.** _Red flag:_ information leakage and overexposure.

- _Change:_ `finalizeRun({ ownerless: true })` takes and releases the `{ ends: true }` claim itself. That removes the caller-side handling at `runRegistry.ts:672-677`, `runLifecycle.ts:308-315` and `runLaunchGuard.ts:36-49`.
- The public session API reports `owned_elsewhere` as a typed refusal, as `resumeRun.ts:252` already does. Then `chatSessionController.ts:419-424` and `executeCli.ts:559-566` stop decoding `DatabaseNotOwner`, and `heldElsewhereBy` leaves `host.ts:93`.
- _Estimate:_ -30 to -45 lines, from the cited ranges.
- _Peer:_ DeepSeek's lease has a single consumer outside persistence.
- _Status:_ the claim half is ALREADY QUEUED (row 4, S4 "activation holds the claim"); the host-facing refusal is NEW.

**3. Have `finalizeRun` return the end it persisted.** _Red flag:_ temporal decomposition. The outcome is computed before the write so a presentation event can be built, and then recomputed.

- _Change:_ `FinalizedRun` carries `{ recorded, outcome, error }`, taken from `endIn`'s `persisted` (`runLifecycle.ts:239`). `endActivation` builds `ResultEvent` from it and drops `AgentRunLifecycle.ts:122-131`.
- Also route `runLaunchGuard.ts:202` through the same path, or document why the child's lost-trace check is skipped there.
- _Estimate:_ -10 to -15 lines.
- _Peer:_ pi's `endRun` (`live.ts:268`) is the single statement of the result.
- _Status:_ NEW detail inside row 4.

**4. Record why a follow-up was consumed, in the format batch.** _Red flag:_ information leakage into context (8 writers, at least five meanings, one bare row).

- _Change:_ add a disposition to `followup.consumed` (`sessionEvent.ts:298`): `turn | control | stale | closed | answered`. Each writer already knows its value. The receipt in row 7 can then be read from rows instead of inferred.
- _Estimate:_ about +6 schema lines and 8 one-token writer edits. The pay-off is the inference row 7 no longer needs, not lines.
- _Peer:_ pi's `SubmissionRecord` statuses and reasons (`types.ts:495-590`), with monotonic transitions (`transaction.ts:64-80`).
- _Status:_ NEW for row 3. Row 3's list (hook.outcome v2, `run.fact`, fork seeds, `RunEndError.message`, `notBefore`, `allowBypass`) does not include it, and the change is irreversible after the 1.0 freeze.

**5. Organize the held-result protocol by knowledge.** _Red flag:_ temporal decomposition and cognitive load.

- _Change:_ move `deliverHeld`, `deliverOne`, `onHeldResult`, `clearHeld` and `heldParks` (`runLaunchGuard.ts:114-282`) into a module beside the `heldFor` writer. `childTurnResult.ts` is already 389 lines, so a sibling `heldResult.ts` is better.
- Inline the single-caller `runWithLaunchGuard` into `detachedChildRun.ts` and delete `runLaunchGuard.ts`.
- _Estimate:_ about -5 lines (imports and export plumbing). This is a cognitive-load fix, not a line-count win.
- _Peer:_ pi keeps everything about submissions in `harness/submissions.ts` and `live.ts`.
- _Status:_ NEW.

## 4. What TeXRA should refuse

- **DeepSeek's open event map.** Letting every package switch on raw events would undo the reducer ratchet: core events are named in 33 to 39 DeepSeek packages. Keep `row-readers-baseline.json` shrink-only.
- **Durability as an optional plugin.** DeepSeek's checkpoint plugin hides the policy well, but correctness then depends on which profile mounts it, an unknown unknown. TeXRA's publisher commits before effects without any composition choice.
- **Mutable task records indexed by storage.** pi teaches every backend the task's status fields (`sqlite/storage.ts:458,832`). TeXRA has one SQLite store and projections rebuilt from history; storage should stay ignorant of run states.
- **pi's scheduler as the stop owner.** It is deep, but it is a 2,528-line task engine that rechecks `abortReason` 13 times internally, and it breaks the "no flow engine" rule. Take the idea (a durable stop consequence with one owner), not the engine.
- **A session-granular lease.** DeepSeek's file lock is simpler, but TeXRA runs process children inside one database and needs per-run claims. The fix is to hide the per-run claim (recommendation 2), not to coarsen it.

## 5. Corrections

- **PRD, mechanism 2 ("claim is taken in 3 places"; row 4 S4).** At `cae1afc`, `log.hold(` has 13 sites in 7 files, and the `{ ends: true }` hold-and-release sequence alone has 6 sites in 5 files. If "3" means the driver's claim, S4 should still name the `{ ends: true }` sites, or they survive it.
- **Prior review §2 ("there is already one `finalizeRun` writer").** The one writer is `endIn`. `runLaunchGuard.ts:202` calls it directly, bypassing `finalizeRun`'s owned-children cascade, lost-trace rule and backstop. The skipped consequences are inferred, not traced.
- **PRD, mechanism 1 ("policy is read in 4 files").** Confirmed for `approvals.policy(`. The policy's inputs reach further: `approvalPromptsUnavailable` is read in 10 harness files. #14413 should be judged on whether those reads collapse too.
- **Prior review §3.** "Finalization consumes only controls" is confirmed (`loop/rows.ts:182-190` with no kind; `runLifecycle.ts:253`). The review omits a fifth consume meaning: input closed while unread, at `Inbox.ts:228-231`, which consumes every item when no message is pending. That gap supports recommendation 4.
