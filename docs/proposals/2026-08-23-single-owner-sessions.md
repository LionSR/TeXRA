# Single-owner sessions: one process owns a run, nobody else touches it live (2026-08-23)

> **Status:** decision proposal. Written from three read-only sweeps of
> `origin/main` at `48aa063fce` (follow-up admission, cross-host storage,
> composer UI). Every claim below carries a file reference; re-open before
> acting.

## 0. The complaint, and what it actually is

"I wrote a long prompt, got `No active session`, and the prompt was gone."

Two defects stack here, and neither is the one the design docs have been
chasing:

1. **The composer is offered for streams this process cannot deliver to.**
   On startup every host adopts every stream in the shared workspace bucket
   (`SessionHandle.ts:730`, `markUnfinishedStreamsRunning` `:682-690`),
   restart repair leaves foreign-owned ones RUNNING
   (`restartRepair.ts:290-302`), and the webview renders
   `<follow-up-input .visible=${true}>` unconditionally
   (`ToolUseStreamContent.ts:77-90`). Follow-up routing is purely
   in-memory (`executionRegistry.ts:392-416`): a RUNNING stream with no
   local flow context is `no_session`. So any run started in another
   window, or in a previous incarnation of this one, shows a working text
   box that can only fail.
2. **The draft is cleared before anyone knows the outcome.** All three
   hosts clear synchronously at send (`eventHandlers.ts:151-160`,
   `InputBar.tsx:251`) and the send path is `void`/fire-and-forget
   (`followUpCommand.ts:57-72` returns nothing to the webview;
   `desktopAgentExecution.ts:1169` is `void submitFollowUp`). No IPC
   command exists to carry the result back (`src/shared/ipc.ts:108-160`).

Underneath, the follow-up + resume + ownership machinery is ~5,600 LoC
(plus ~6,000 LoC of tests) with ~22 closed enums / ~70 members and about
40 distinct failure exits that the user sees as two strings. The ~1,900 LoC
of presence-socket liveness proof reaches the follow-up surface through a
single edge (`ExecutionLeaseActiveError` collapsed to `false` at
`resolveAndResumeStream.ts:229-233`), so the most actionable fact it can
compute, "another window owns this", is never shown.

**Premise correction.** Real-time cross-host sharing does not exist and
never shipped: no watcher on the shared root (#8658's watchers were
removed by #10811), `StreamLogStore` reads `streamLogs/` once at open,
no cross-process follow-up channel. The sacrifice the maintainer is
offering has, in effect, already been made; the code just does not admit
it, and pays for the ambiguity in every path.

## 0.5 Why it also breaks with the extension alone

A second sweep traced the single-process paths. The mechanism: a root
tool-use chat never ends its turn. `ToolUseWaitNode` parks the flow at
WAITING and blocks on `session.waitForFollowUp` (`ToolUseWaitNode.ts:140-147`),
so the only happy path for a follow-up is "the live flow object is still in
this process". Every `No active session` is a case where that object died
and the durable state was not left in the one shape the resume path accepts
(no outcome or CANCELLED, plus a valid flow record, plus no live lease).
Ranked:

1. **Zombie RUNNING.** Startup does `markUnfinishedStreamsRunning`
   (`SessionHandle.ts:682-690`) _before_ anyone decides ownership, and
   restart repair then declines to touch the stream when the old lease
   is `unprovable` (`restartRepair.ts:290-302`), when the execution id
   cannot be read (`SessionHandle.ts:751-761`), or when
   `detectWaitingStreams` throws, which drops every stream with an
   execution id from the repair set (`:780-793`). The phase stays RUNNING
   with no flow behind it; `repairWaitingIfResumable` bails on
   `isInFlightPhase` at `:368` without probing; the registry answers
   `no_session, status: running`. Permanent: the exit watch gives up after
   two `unprovable` verdicts (`instancePresence.ts:320-328`). Data intact
   but unreachable.
2. **Reload mid-turn, repaired to FAILED, checkpoint deleted.**
   `repairRestartedStream` (`restartRepair.ts:396-408`) writes FAILED and
   `finalizeExecution({flowRecord:'delete'})`. `deriveResumability`
   returns non-resumable for any terminal outcome before reading the flow
   record (`resumability.ts:76-84`). Data destroyed; the conversation can
   never continue. Note `detectWaitingStreams` uses the lease-aware
   variant and `repairWaitingIfResumable` does not, so at startup a stale
   lease demotes a stream into this arm while at follow-up time the same
   stream would have been repaired to WAITING. The two call sites
   disagree by construction.
3. **Stale lease, `unprovable`, resume refused.** Pid reuse after reboot
   (`ENOENT` but `kill(pid,0)` succeeds, `instancePresence.ts:204-206`),
   `EACCES` on the socket path, or a probe timeout all yield `unprovable`,
   which `leaseOwnerIsActive` treats as alive (`executionLease.ts:325-338`).
   `acquireExecutionLease` throws, collapsed to `resume_failed`: two
   toasts and the message parked forever.
4. **Any exception escaping the flow mid-turn** (persisted-state error,
   flow-record write failure, handler construction, structured-output
   violation) ends in FAILED plus `'delete'` (`runToolUseFlow.ts:585-611`,
   `AgentRunLifecycle.ts:206-218`) and a tombstoned queue. Provider errors
   are _not_ this: `execFallback` absorbs them and the run parks at WAITING.
5. **Queue disposed under a live parked root flow** resolves the wait with
   `null` without aborting (`FollowUpQueue.ts:149-158`), which the flow reads
   as COMPLETED, so the record is deleted. The flow cannot tell "queue
   taken away" from "turn finished".
6. Stop works, but only through the resume path, so it inherits 3.

Sleep is clean (no clock anywhere since #10778). Startup ordering is safe
today except on storage-root change. Generation fences never apply to
user follow-ups (the extension passes no options).

Two structural facts underlie all six: **stream status is remembered,
not derived** (a RUNNING value survives in a map with no flow behind it),
and **terminal outcomes are inferred, then used to justify deleting the
checkpoint**.

## 0.9 Governing rule: no guessing

Every run-state fact is either **written explicitly by its one owner** or
**derived from a kernel fact**. Nothing is inferred from the shape of
other data, from timestamps, or from the absence of a write. Where a fact
cannot be established, the answer is "unknown, shown to the user, nothing
mutated", never a default that lets code proceed.

Guessing sites the sweeps found, each of which this proposal removes:

| Guess                                                                   | Where                                                                              | Replaced by                                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| "finished" inferred from unclosed group rows                            | `StreamLogStore.ts:327-333`, `:1528-1540`; consumer `markUnfinishedStreamsRunning` | an explicit `status`/`result` journal row (§6) or `meta.outcome`; never the transcript shape |
| "running" remembered in a map with no flow behind it                    | `SessionHandle.ts:682-690`, `StreamStatusService`                                  | RUNNING/WAITING ⇔ a live flow context exists in this registry (D7)                           |
| owner alive inferred from a socket probe; `unprovable` treated as alive | `instancePresence.ts:159-213`, `executionLease.ts:324-338`                         | `kill(pid,0)` + process start time; `unprovable` is shown as held, like `alive` (D2, D9)     |
| FAILED inferred by restart repair, then used to delete the checkpoint   | `restartRepair.ts:396-408`                                                         | repair never writes an outcome and never deletes (D8)                                        |
| "not resumable" inferred from outcome before reading the checkpoint     | `resumability.ts:76-86`                                                            | resumable ⇔ checkpoint present and no live owner                                             |
| stream → execution read from one of three copies with a fallback ladder | `SessionHandle.ts:745-763`, `ToolUseFollowUp.ts:84-95`                             | one authored FK (`meta.streamId`, or the journal header), one derived index                  |
| summary freshness decided by mtime comparison                           | `StreamLogStore.ts:1422-1435`                                                      | summaries deleted with the journal; until then, rebuilt, never trusted by mtime              |
| "queue taken away" read as "turn completed"                             | `FollowUpQueue.ts:149-158` → COMPLETED + delete                                    | `waitForFollowUp` returns why it stopped; disposal is a cancellation                         |
| every follow-up failure collapsed to "start a new agent task"           | `followUpCommand.ts:43-48`, `desktopAgentExecution.ts:1194-1196`                   | a worded reason from the classifier (D6)                                                     |
| a foreign-owned stream treated as mine at startup                       | `SessionHandle.ts:730`, `restartRepair.ts:290-302`                                 | classify once, mutate nothing (D3)                                                           |
| WAITING re-derived at startup by a different function than at send time | `detectWaitingStreams.ts` vs `repairWaitingIfResumable`                            | one classifier, called from both (D7)                                                        |

The `.catch(default)` / silent-fallback ban already in CLAUDE.md is the
same rule at the schema layer; this section applies it to run state.

## 1. Decisions

**D1. A run belongs to the process that started it, for its whole life.**
Another process never loads that run's stream into its live session while
the owner is alive. Shared `~/.texra` storage stays: it is the history
store and the crash-recovery store, not a live bus. Finished runs are
readable anywhere after they finish. Unfinished foreign runs appear in
history as "running in another TeXRA window", read-only, with no
composer.

**D2. Liveness is a pid check, not a socket protocol.** The lease record
keeps `{executionId, ownerToken, pid, processStart, hostname}`, where
`processStart` is an opaque identity the `processes` port produces that
cannot change under a live process (Linux: boot id plus raw start ticks
from `/proc/<pid>/stat`; macOS/BSD: `ps -o lstart=` under `LC_ALL=C`;
Windows: the PowerShell process start time). An owner is dead iff
`kill(pid, 0)` gives `ESRCH`, or the pid exists with a different identity
(pid reuse). Anything else (a different hostname, a pid on this host
whose identity cannot be read) is "unprovable", which means exactly what
"alive" means: do not touch. This is sleep-safe (the
failure that motivated the presence PRD was wall-clock TTLs, which this
does not reintroduce) and deletes `instancePresence.ts` (367 L), the
owner-exit watch (`SessionHandle.ts:869-891`), and the probe plumbing in
`restartRepair.ts` and `executionLease.ts` (~150 L). Fencing
(`withLeaseLock`, `ownerToken`, acquire refusal) is correct and stays.

**D3. No automatic adoption of anyone else's run.** When a host starts, it
classifies each unfinished stream in the bucket once:

- lease owner alive → foreign, read-only, not in the live session;
- lease absent or owner dead → resumable-by-me; shown with a
  "Resume" affordance, not marked RUNNING, not marked FAILED, flow record
  untouched (this also fixes the lossy repair at
  `restartRepair.ts:396-408`).
  Resume is a user action (or the explicit `--resume` / history path). There
  is no reaper, no exit watch, no background takeover. If the user had two
  windows and one crashed, the other window shows "Resume" after its next
  history refresh; that is the sacrifice, and it is cheap.

**D4. The composer exists only where delivery is possible.** Visibility
becomes a predicate over two facts the session already has: the stream is
in the live registry of this process (RUNNING/WAITING with a flow
context or a queue target), or it is resumable-by-me. Otherwise the tab
shows a one-line read-only banner. `repairWaitingIfResumable` stops being
a pre-send probe and becomes part of the D3 classification.

**D5. Never clear a draft without an ack.** _Shipped in #11303; the wire
payload is `{stream, accepted: boolean}` and the extension composer calls
the shared `submitProgressFollowUp` directly rather than the
`texra.sendFollowUp` command._ Add one outbound command
`followUpResult {stream, status}` to `PROGRESS_VIEW_COMMANDS`. The webview
marks the draft in-flight on send, clears only on `sent | queued`, and on
failure restores focus with the text and pasted images intact. Extension:
`texra.sendFollowUp` returns the result and
`ProgressViewMessageHandler.ts:532-538` posts it back. Desktop: the
existing `.then/.catch` in `desktopAgentExecution.ts:1169-1200` posts it
(send a failure ack from `.catch` too). CLI: `InputBar.tsx` keeps
`{text, media}` and `chatSubmitDriver.ts:315-330` restores it on
`no_session | dropped`, exactly where `restoreReservedSkillActivations`
already runs.

**D6. Three outcomes, not thirty.** `SubmitFollowUpResult` becomes
`sent | queued{wake?} | failed{reason}` where `reason` is a short enum the
UI can word: `finished`, `owned_elsewhere`, `not_resumable`. A queued input
whose recovery resume did not reach the run is `queued` with
`wake: 'failed'`: it was admitted and an explicit Resume delivers it, so no
consumer hands the draft back or re-offers it.
Internal submission kinds may survive inside the queue manager, but the
generation-fence restore (`ToolUseFollowUp.ts:108-167`, six diagnostics)
and `existing_recoverable` admission exist only because foreign or stale
streams were adoptable; under D3 they go.

**D7. Stream status is derived, never remembered.** RUNNING/WAITING in
this process means exactly "a live flow context exists in the registry".
Everything else is computed once from disk at load (and on demand on
send): `held_elsewhere` (lease owner alive), `resumable` (checkpoint
present, lease absent or dead), `finished` (outcome, no checkpoint).
`markUnfinishedStreamsRunning`, `repairWaitingIfResumable`, the
resident-vs-cold probe, and `detectWaitingStreams` all disappear into one
classifier that mutates nothing.

**D8. A checkpoint is deleted only by the user.** _Shipped in #11304._ No inferred outcome may
delete the flow record: restart repair never writes FAILED and never
deletes; an escaped exception persists FAILED but keeps the record; the
queue being disposed is a cancellation, not a completion
(`waitForFollowUp` returns why it stopped). Resumability becomes
"checkpoint exists and nobody alive holds the lease", independent of the
outcome, so a FAILED run offers "retry from last checkpoint". This
collapses `RESUMABILITY_CAUSE`'s eleven members to three.

**D9. An undecidable owner is shown as held.** With pid + start time (D2)
the remaining unprovable cases are genuine anomalies (foreign hostname,
permission error). No code path guesses them dead: the run is shown as
unavailable with the owner's pid and host in the detail, every message to
it is refused with that same detail, and Delete is the user's only action.
There is no reclaim; a user who knows the owner is gone deletes the run.

**D10. Races are removed by structure, not guarded by locks.** A lock,
fence, generation counter, or double-check exists only because two things
are allowed to overlap. The design forbids the overlap; the guard is then
deleted, not kept "for safety". Four structural rules do the work:

1. **One owner per run, for its whole life** (D1). No second process ever
   writes to a live run's files, so there is nothing to fence
   cross-process except the initial claim.
2. **Claims are single atomic kernel operations.** Claim a run by creating
   its lease file with `O_EXCL`; exactly one creator wins, no lock
   directory, no read-modify-write, no `withLeaseLock`. Reclaim a dead
   owner's run by `rename`-ing its lease to a tombstone first (one renamer
   wins) and then creating with `O_EXCL`. Release is `unlink`. The
   `ownerToken` write fence survives only as a cheap assertion on
   `ExecutionKVStore` writes, never as a recovery mechanism.
3. **One serial queue per execution, in-process.** Launch, resume, stop,
   follow-up, delete, and terminal finalization for execution X all run
   through one `p-queue` keyed by X. A resume cannot start until the
   previous generation's run handle has fully disposed, so generations
   never coexist and there is no "successor lease" for a delayed
   continuation to borrow. The per-stream `KeyedMutex` in the follow-up
   manager and the `isActiveOrResuming` double-check in
   `resolveAndResumeStream` become the same queue.
4. **No implicit transitions.** Sending a message never starts a resume
   (D4); restart never mutates (D3/D7); a child's completion is awaited by
   its parent before the parent may go terminal; a storage-root change is
   refused while any execution is live. Every state change is a user
   action or a flow step, and each runs on the queue above.

| Race today                                               | Guard today                                                                                                 | Structural removal                                                                                          | Guard deleted                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| two processes claim one execution                        | file lock dir + read-modify-write + `ownerToken` compare                                                    | `O_EXCL` create; tombstone-rename reclaim                                                                   | `withLeaseLock`, `executionLocks/`, `fileLocks.ts` port, `runWithValidatedOwnership` as recovery |
| delayed continuation of generation N borrows N+1's lease | `captureOwnedExecutionLease` ALS scoping (39 L, 15 sites)                                                   | generations serialized per execution; N+1 cannot exist until N is disposed                                  | the ALS capture and both `IfPresent` variants                                                    |
| stream reused between discovery and repair               | `isRepairCandidateCurrent`, status generation counters                                                      | classifier runs before the session accepts any launch and mutates nothing                                   | `getGeneration` / `isCurrentGeneration`, `isRepairCandidateCurrent`                              |
| follow-up races a resume on the same stream              | per-stream `KeyedMutex`, `isActiveOrResuming`, `ResumeAdmissionCancelledError`, `runSubmissionExclusive`    | follow-up never resumes; resume is a queued user action; follow-up to a non-live stream fails with a reason | the mutex, the double-check, the cancellation error                                              |
| late child result after the parent went terminal         | `existing_recoverable` admission, terminal tombstone LRU (500)                                              | parent awaits all children before terminal (structured concurrency)                                         | `existing_recoverable`, the tombstone LRU                                                        |
| delete while resuming / while live                       | desktop `hasAuthoritativeStream`, `waitForOwnedExecutionRelease`, `runWithInactiveExecutionLease` on delete | delete is offered only for `finished` and `resumable`, and runs on the same per-execution queue as resume   | all three                                                                                        |
| storage-root change while executions flush               | `ExecutionLeaseCoordination` + quiescence barrier (94 L)                                                    | refuse the change while any execution is live, with a message                                               | the coordinator                                                                                  |
| sidecar FK flushed async after the summary mirror        | "mirror arm is load-bearing" fallback ladder                                                                | `meta.streamId` written atomically inside `registerExecution` before the run can emit anything; one FK      | both mirrors and the ladder                                                                      |
| lease file removed out of band under a live run          | `onOwnedExecutionLeaseLost` listeners                                                                       | accepted as tampering: the next fenced write throws `ExecutionLeaseLostError` and the run aborts dirty      | the listeners (13 L + 2 watchers)                                                                |
| draft cleared before the outcome is known                | none                                                                                                        | ack before clear (D5)                                                                                       | n/a                                                                                              |

This revises the inventory's keep list (§2): the ALS scoping, the
quiescence coordinator, the status generation counters, the lease-loss
listeners, and `existing_recoverable` move from "keep" to "deleted by
D10". The durability-retention triad stays: it is not a race guard, it is
the rule that a run whose artifacts failed to flush must not be offered
as resumable. What is given up: changing the storage root mid-run (was
possible, now refused), and a clean abort when someone deletes a lease
file out from under a live run (now a dirty abort at the next write).

## 2. What this buys

| Area                                                 | Today                | After                                          |
| ---------------------------------------------------- | -------------------- | ---------------------------------------------- |
| `instancePresence.ts`                                | 367                  | 0                                              |
| `executionLease.ts`                                  | 832                  | ~770 (fencing, retention, quiescence stay)     |
| `restartRepair.ts`                                   | 411                  | ~150 (classify, never mutate)                  |
| `resumability.ts` offerable layer                    | ~90                  | 0 (`meta.outcome` + lease owner)               |
| `SessionHandle` adopt/repair/probe/watch             | ~220                 | ~0 (one classifier, ~90 in `runRestartRepair`) |
| `ToolUseFollowUp.ts` generation restore + vocabulary | ~150                 | 0                                              |
| `detectWaitingStreams.ts`                            | 32                   | 0                                              |
| user-visible outcomes                                | 2 strings, 40 causes | 3 outcomes, 4 worded reasons                   |
| tests pinned to the above                            | ~6,000               | roughly half                                   |

Net about -1,100 production LoC (the inventory sweep held back the
quiescence coordinator, the durability-retention triad, the ALS lease
scoping, `onOwnedExecutionLeaseLost`, `computeStartupSeedSet`, and the
`existing_recoverable` admission, each of which guards a real in-process
race; details in the sweep) plus ~1,400 test LoC deleted outright
(`SessionWaitingRepair.vitest.ts` and `FollowUpCommandWaitingRepair.vitest.ts`
whole, large parts of `RestartRepair`, `SessionRestartRepair`,
`ToolUseFollowUp`, `executionLeaseFixtures`). The real win is that every "no active session" becomes impossible to
reach from the UI except as a worded, non-destructive failure.

## 3. What is given up

- No live view of a run from a second window. (Did not exist.)
- No automatic reaping of a sibling window's crash; the survivor sees
  "Resume" on its next history refresh instead. (Was kernel-pushed.)
- Cooperative handoff and the per-workspace daemon stay non-goals, as the
  presence PRD already ruled.
- Cross-machine shared storage (network home dirs) is unsupported; the
  pid check refuses on hostname mismatch, same as today.

## 4. Order of work

1. D5 alone (draft retention + ack), all three hosts, one PR. Stops the
   bleeding with no storage change.
2. D8 alone: stop deleting checkpoints on inferred outcomes and make
   resumability outcome-independent. Small diff, ends the data loss in
   scenarios 2, 4, 5.
3. D7 + D4: derived status, one classifier, composer gated on it, the
   read-only / resumable / held banners. Deletes `repairWaitingIfResumable`
   and the adoption pass.
4. D3 + D2 + D9 together: startup classification replaces adoption + repair;
   pid liveness replaces presence; delete `instancePresence.ts`. This is
   the PR that supersedes
   `docs/prds/2026-08-16-prd-execution-liveness-presence.md` §3.1-3.3
   while keeping its §2 principle (never destroy on ambiguity) and its
   fencing.
5. D6: collapse the result vocabulary and delete the generation-restore
   path; retire the tests that only pinned the deleted states.
6. D10: the per-execution queue replaces the follow-up mutex, the resume
   double-check, and the ALS scoping; `O_EXCL` claims replace the lock
   directory; parents await children; storage-root change refuses while
   live. Each guard is deleted in the same PR as the structure that makes
   it unnecessary, never before.

Steps 1 to 3 are independent of the session-event-journal PRD
(`2026-08-18-session-event-journal.md`) and should not wait for it. Step 4
touches `executionLease.ts`, which that PRD does not own.

## 5. Surface areas (three sweeps, 2026-08-23)

### 5.1 Export and caller graph

24 files, 130 exports, 23 dead (zero production callers; four already in
`config/ratchets/knip-baseline.json`), 41 barrel re-exports, and **no host
deep-import specifier into any of these modules** in
`config/ratchets/host-agent-import-baseline.json`. The SDK
(`packages/agent`) reaches only the `SessionHandle` class, constructs it
with an ephemeral `StreamLogStore`, so `waitUntilReady` short-circuits and
the adoption/repair pass never runs for SDK consumers. Blast radius is
therefore in-repo and barrel-shaped, not public.

Isolated (structurally cheap to delete): `instancePresence.ts` (3 consumer
files, 1 test file), `detectWaitingStreams` (1 call site),
`repairRestartedStreams` (1 call site, 411 L), `repairWaitingIfResumable`
(1 host call site). Expensive rewrites, ranked by fan-out: `submitFollowUp`
(5 layers, 13 test files), `finalizeExecution` (17 test files),
`StreamStatusMachine` (15 methods, 14 test files, 2 `src/controllers` deep
importers), `retrieveSessionResumeData` (10), `deriveResumability` (12
production sites, 3 layers). `resolveAndResumeStream.ts` is effectively a
host adapter: 4 of its 5 live exports have zero core callers.
`terminalPersistence.ts` sits on the D8 write path with zero direct tests
and a storage→runtime back-edge.

Caveats outside the ratchet: `packages/cli/scripts/tui-harness.tsx` deep
imports `@agent/runtime/SessionHandle`; in-`src` deep imports into these
modules are numerous and unratcheted (`src/tools/**`, `src/controllers/**`);
the header comment in `src/agent/storage/index.ts` is stale.

### 5.2 Host surfaces

The progress-view Lit frontend is shared by extension and desktop, so tab
glyphs (`StreamTabs.ts`), the header pill and the toolbar enable table
(`StreamHeader.ts:74-155`, table-driven by `StreamStatusDisplayKey`), and
the composer (`ToolUseStreamContent.ts:78`, `.visible=${true}`) are one
change each. Status chips on all three hosts come from one label table
(`src/shared/streams/streamStatusDisplay.ts`), which gains
`held_elsewhere | resumable | finished`. The extension status bar counts
`isActivePhase` streams, so a zombie RUNNING inflates "TeXRA: N active"
permanently; it must exclude `held_elsewhere`.

The extension has **no history surface at all**; desktop's was deleted in
#10811. "Foreign runs appear read-only in history" is a new surface on
those hosts, not a modification. The CLI already has the right shape:
`texra resume` inspects the lease and refuses on `owned|foreign`
(`resumeExecution.ts:93-101`); `focusedChildFollowUp.ts` already gates a
composer on phase + identity, but only for child streams.

Desktop has no live-run warning on quit or window close
(`index.ts:512-533` only warns about unsaved buffers); under D1 that is
the moment a run becomes resumable elsewhere, so the copy belongs there.

One-home-per-action violations to collapse while touching this:

- **Resume** has four homes: toolbar button, implicit auto-resume as a
  side effect of sending a follow-up (`ToolUseFollowUp.ts:285-289`, with
  its own vocabulary and copy), `texra resume`, and the `/resume` TUI form
  (which does not inspect the lease). D4 keeps the explicit ones and
  deletes the implicit one: a resumable stream shows Resume; the composer
  appears after the resume succeeds.
- **Stop** has three (toolbar, `texra.stopAgent` bypassing
  `ProgressBackend`, implicit stop inside delete).
- **Delete** has three result vocabularies; only the CLI ever tells the
  user an active lease blocked it.
- **Ownership check** has three implementations (`inspectExecutionLease`,
  desktop `hasAuthoritativeStream`, `waitForOwnedExecutionRelease`).
- The resume hint is spelled three ways by three producers.
- `repairWaitingIfResumable` runs in exactly one host, so the same stream
  behaves differently per host today.

Model-facing: `ExecutionsTool` never reads the lease, so a run held by
another process is shown with its stale persisted status;
`DelegationTools.ts:315-372` is the only consumer of all five
`SubmitFollowUpResult` arms. Frozen wire: NDJSON `updateStreamStatus` is
typed `StreamPhaseSchema`, so new derived keys need a boundary projection
or stay off the wire.

User-facing strings tied to these states (to rewrite once): the two
presenter strings in `ToolUseFollowUp.ts:62-72`; "No active session. Start
a new agent task to continue." duplicated verbatim in
`followUpCommand.ts:46` and `desktopAgentExecution.ts:1195`; three
differently worded "cannot be resumed" messages
(`resumeFromResumeData.ts:106`, `desktopAgentResume.ts:144`,
`resumeExecution.ts:30`); "Execution {id} is active in TeXRA." spelled in
`executionLease.ts:107` and again in `resumeExecution.ts:45`.

### 5.3 Schemas and persisted formats

**24 closed vocabularies (~80 members) and 21 mapping functions** answer
"what state is this run in". Under the proposal: 8 vocabularies.
Frozen and untouched: `RUN_OUTCOME` (persisted `meta.outcome`),
`EXECUTION_STATUS` (trace export and CLI NDJSON), `HISTORY_RUN_STATUS`
(CLI), `STREAM_STATUS` (legacy trace import only), `AgentFinalResult`
field names, `toNdjsonHistoryStatus`. Deleted: `RESUMABILITY_CAUSE` 11→3,
`ExecutionLeasePresence` 4→2, `ResumeFailureDescription`,
`ResumeStateResolution`, `ExecutionSettlement`, the repair result kinds,
the `queued.reason × continuation` cross-product, `duplicate`,
`no_session{streamStatus}`, `STREAM_TRANSITION_CAUSE.RESTART_REPAIR`,
`STREAM_SUBSTATE.RESUMING`, `InstanceOwnerSchema.{instanceId,socketPath}`.
About 50 of 80 members.

Multi-authority facts on disk, and the single authority each collapses to:

| Fact               | Authorities today                                                                                                                                                                                         | Target                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| how the run ended  | `meta.outcome`, `result-meta.json.result.outcome` (reconciled by `applyExecutionOutcome`), transcript root `GROUP_END.status`, `trace.terminalStatus`                                                     | `meta.outcome`; result-meta stops writing it; GROUP_END stays a rendering fact |
| who owns it now    | lease file, in-memory RUNNING, `streamLogSummaries.hasRunning*`                                                                                                                                           | lease file; RUNNING = live registry entry                                      |
| stream ↔ execution | `streamData/<id>/meta.json.executionId`, `streamLogSummaries/<id>.json.meta.executionId`, `executions/<id>/meta.json.streamId`; two readers each consult two with a "mirror arm is load-bearing" fallback | `meta.streamId` authored; reverse index derived at load                        |
| resumable          | flow record presence + outcome gate + lease liveness                                                                                                                                                      | flow record presence + lease liveness                                          |
| current phase      | in-memory machine, `StreamSnapshot.status`, wire `UPDATE_STREAM_STATUS`                                                                                                                                   | derived once per load, never stored                                            |

Proposed fact model:

```ts
// authored (persisted)
ExecutionMeta = { ..., streamId, outcome?: 'completed'|'cancelled'|'failed' }  // never gates deletion
flow_<id>.json            // present ⇔ a continuation exists; deleted only by the user
StoredLease = { version: 3, executionId, ownerToken, acquiredAt,
                owner: { pid, processStartTime, hostname } }

// derived (in-memory, discard + rebuild)
type RunState =
  | { kind: 'live'; phase: 'running' | 'waiting' }          // live flow context in THIS registry
  | { kind: 'held_elsewhere'; owner; provable: boolean }     // lease present, owner alive or unprovable
  | { kind: 'resumable' }                                    // checkpoint, no live owner
  | { kind: 'finished'; outcome?: RunOutcome }               // no checkpoint
classifyRun(execId): RunState   // reads meta + flow + lease; mutates nothing
composerVisible = kind === 'live' || kind === 'resumable'
```

**Migration verdict: none needed.** Everything that changes is derived
tier under the #9434 rule (`StreamLogStore.ts:97-105` states discard and
rebuild for the summary). Lease v2 → v3 reuses the existing v1 tombstone
arm. Rolling-upgrade shim, delete after v0.41 ships: a v3 owner also keeps
a v2-shaped record at the old single-file path naming its pid and a socket
path that does not exist, so a 0.40.4 process sees an active owner and
backs off (`legacyShadowRecord` in `executionLease.ts`). `meta.json` and `flow_*.json` are authored and do not change shape;
D8 changes who writes `outcome` and when the flow record is deleted, not
the format.

**Contract trap.** `texra history` NDJSON `status` is a frozen field
consumed by texra-action. If D8 makes FAILED runs resumable,
`resolveHistoryRunStatus` would start emitting `resumable` where it emitted
`error`. Add a sibling `resumable: boolean` (and keep `hasFlowRecord`)
rather than re-meaning `status`.

## 6. Would an append-only JSONL journal help? Partly.

Measured against this machine's real store (`~/.texra`, 6.6 GB; one
workspace 3.7 GB; the journal PRD's "991 MB" is now conservative).

**Where it helps the ownership problem, and it is not the part the PRD
sells.** The transcript recorder deliberately writes no row for `status`
or `result` (`TexraTranscriptRecorder.ts:804-807`, `:833-870`), so "is this
stream finished?" is inferred from unclosed group rows
(`StreamLogStore.ts:327-333`), which is the only reason
`markUnfinishedStreamsRunning` exists. Journaling `status` and `result`
makes D7 durable instead of an in-memory rule, and the journal header
carrying `executionId` / `parentStreamId` collapses the three-way FK
duplication and the "mirror arm is load-bearing" ladder at
`SessionHandle.ts:745-763`. That is the single cleanest journal win for this
problem. Both are cheap additions to the PRD's §3.3 and should be
negotiated in now.

**Where it cannot help.** Liveness is not a fold of a file: a
`lease-acquired` line with no `lease-released` line _is_ the stale lease
file with the same failure mode, and treating "last line says acquired" as
ownership is the remembered-not-derived mistake one layer up. D2 stays.
A crashed WAITING host and a live parked one produce byte-identical
journals.

**The checkpoint cannot be a fold of the journal.** `flow_<id>.json`
holds the raw provider message array plus thinking-block signatures,
compaction summaries that exist only in the array, `previous_response_id`
chains, and attachment handles. The journal is admission-redacted
(`redactSecrets` is applied only in the recorder, never to
`shared.messages`), truncated at 50 KB / 2,000 lines per entry with spill
files, and records display results rather than the provider-serialized
tool messages; thinking reaches the trace only as live deltas that are
never persisted. The deepseek "model-visible means logged" invariant the
PRD cites is exactly the invariant this codebase does not have. Separately,
the checkpoint is the largest write amplifier measured: 2,309 files,
1.43 GB (~65% of `executions/`), p50 547 KB rewritten atomically on every
outer node transition, max 12.8 MB. An append-structured _context_ log
with an explicit compaction line would be a real optimization, but it is a
different file with different security properties. Keep it out of the
transcript PRD; evidence-gate it later.

**Two corrections to existing docs.** The journal PRD's §3.4 writer
authority "rides presence leases (#10778) unchanged", which is the
mechanism D2 deletes; this proposal's §4 claim that the PRD does not own
`executionLease.ts` is true about files and false about premises. And
`StreamLogStore` has no lease fence (unlike `ExecutionKVStore`), so two
hosts adopting the same stream today race whole-file renames and one
silently loses its entire transcript; under `O_APPEND` that would be
interleaved-but-recoverable. That argues for the journal even before D1,
and for D1 before the journal so single-writer-per-stream is structural
rather than asserted.

**Sequencing.** Steps 1 to 3 unchanged and independent. Step 4 (D2/D3/D9)
lands _before_ the journal so §3.4 is written once against pid liveness.
Then journal stage 1 with the two additions above. Prior art in-tree: the
only real JSONL appender is the CLI input history
(`inputHistory.ts:13-99`, rotation by full rewrite past 1,000 lines);
`platform().fs.appendFile` exists; a held `'a'` write stream would be new
platform surface. Streaming deltas must stay live-only or a 384 KB
transcript becomes tens of MB.
