# Startup restart repair is the wrong shape (2026-09-03)

> **Status:** decision proposal. Measured on `main` at `1fbcaa0108` with an
> env-gated trace (reverted, not committed). Reference codebases were read on
> 2026-09-03: Claude Code (readable source), Codex (`codex-rs`), OpenCode,
> Gemini CLI. Every claim carries a file reference; re-open before acting.
> Companion: `2026-09-03-persistence-substrate-decision.md` owns the storage
> engine. This document owns lifecycle: what boot may do, where terminal
> facts are written, and ownership. S4, S5, and S7 below are delivered by the
> companion's SQLite stages; they are kept here only to name the contract.

## 1. The complaint, measured

`texra chat --agent X --model Y` in a workspace with ~4,100 execution
directories (3,125 still holding a `flow_<id>.json` checkpoint, 1.8 GB of
checkpoint JSON, 600 KB average) takes 48 to 112 seconds to show the input
box. The agent and model pickers are not the cost. Breakdown of one launch:

| Step after the pickers                                  | Time        |
| ------------------------------------------------------- | ----------- |
| `StreamLogStore.open` (summary cache)                   | 1.5 to 2 s  |
| `SessionHandle` restart repair (`waitUntilReady`)       | 43 to 108 s |
| `sweepLeftoverStreams`                                  | 2 to 15 s   |
| agents, model, input history, terminal probe, Ink mount | < 0.5 s     |

Inside repair (`src/agent/runtime/SessionHandle.ts` `runRestartRepair`,
`src/agent/runtime/restartRepair.ts`):

- scan (`listExecutionStreamReferences({ checkpointedOnly: true })`, stat +
  meta per execution): 1.8 s;
- phase 1, classify ~1,900 checkpointed streams, 8-wide: ~4 s, each parsing
  the full checkpoint (`deriveResumability`) plus a lease inspection;
- phase 2, settle those same ~1,900 streams **sequentially**, each under
  `runWithInactiveExecutionLease`, re-parsing the full checkpoint via
  `classifyRunFacts`: 37 s and up. For a run that already has a persisted
  outcome this writes nothing.

Raw read plus `JSON.parse` of all 3,125 checkpoints is 7 s; the Zod envelope
is shallow (`shared: z.unknown()`). The cost is per-run overhead multiplied
by duplication, not parsing per se. Per launch the executions directory is
scanned three or four times (repair scan, `readExecutionStreamIndex` in the
orphan sweep, `listExecutionStreamReferences` again in
`sweepOrphanedExecutions`, `listExecutions` in the launcher) and every
checkpoint is parsed up to three times (launcher history row `classifyRun`,
repair phase 1, repair phase 2).

The extension and desktop hosts run the same pass (`extension.ts:499`,
`desktop/src/main/index.ts:1341`).

## 2. Why it is O(history) and will stay that way

Completed tool-use chat runs keep their checkpoint so Resume can continue
them (D8 in `2026-08-23-single-owner-sessions.md`). Repair treats "has a
checkpoint" as "needs classification", so the candidate set is the whole
history and only grows. In the measured workspace 1,985 checkpointed runs
already carry a persisted outcome; repair re-proves them every launch.

The 2026-08-23 proposal already rules the right shape (D3 "classify once,
mutate nothing", D7 "stream status is derived, never remembered"). The code
has not caught up: phase 2 still mutates (closes transcript groups, records
CANCELLED, assigns in-memory phases) for every candidate, under a lock, one
at a time.

## 3. What the four references do instead

All four converge on the same five properties. None has a startup repair,
settle, or classification pass.

| Property                       | Claude Code                                                             | Codex                                                                                                                 | OpenCode                                                                                                  | Gemini CLI                             |
| ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Storage unit                   | per-message JSONL append                                                | per-item JSONL append                                                                                                 | per-message/part SQLite row                                                                               | per-message JSONL append               |
| Startup touches prior sessions | no (only `--continue`/`--resume`)                                       | no (one-shot leased backfill into SQLite, then a "complete" flag)                                                     | no (schema migrations only)                                                                               | no                                     |
| "Interrupted" state            | derived at resume from the log tail (`conversationRecovery.ts:272-330`) | derived at resume from the tail; synthetic `TurnAborted` appended only on fork/resume (`thread_manager.rs:2210-2330`) | written at interrupt time (`prompt.ts:1203`); readers tolerate an unrepaired row (`projector.ts:135-147`) | none; the log just ends                |
| Resume eligibility cost        | 64 KB head + tail per file, first 50 only                               | head only (10 to 210 records)                                                                                         | one indexed query                                                                                         | header-only stream, only on `--resume` |
| Ownership                      | pid file + `kill(0)`, used to skip, not lock                            | OS file lock per thread taken on open-for-write (`writer_lock.rs`)                                                    | in-process map only                                                                                       | none                                   |
| Cleanup                        | 30-day mtime TTL, deferred 10 min, throttled                            | background zstd job with run marker                                                                                   | FK cascade on delete                                                                                      | background TTL, un-awaited             |

Decisive evidence paths, one per reference: Claude Code
`src/utils/sessionStorage.ts:4527-4808` (readdir + stat + head/tail),
`src/utils/backgroundHousekeeping.ts:44-79`; Codex
`rollout/src/state_db.rs:95-190` (backfill state flag),
`thread-store/src/local/writer_lock.rs:41-77`; OpenCode
`packages/core/src/session/sql.ts:22-98`, `session/status.ts:26-33`;
Gemini CLI `packages/cli/src/gemini.tsx:211-213, 669-672`.

## 4. Verdict

Restart repair as a startup pass is a design mistake, by the standard of
every reference and by TeXRA's own D3/D7. The underlying mistake is
remembering run status on disk in a form that every future process must
reconcile before it may show a prompt. The references instead derive status
from the log at read time and write terminal facts at the moment of
failure, so no process ever owes the past anything at boot.

Three secondary mistakes compound it:

1. Resumability requires parsing the whole checkpoint to read a two-field
   cursor (`src/agent/storage/resumability.ts:96-119`).
2. The checkpoint is whole-state rewritten per node, so the artifact every
   consumer must open is the largest one on disk.
3. Ownership is a lease inspected for every run on disk at boot instead of
   a lock taken for the one run being opened for writing.

## 5. Target shape

Ordered by leverage. Each step is independently shippable and leaves no
compatibility shim.

**S1. No history work on the interactive path.** Delete the startup
repair and the orphan sweep from `waitUntilReady`. Startup opens the
transcript summary index (already lazy per #9947) and nothing else. A
stream's phase is a pure function evaluated when it is displayed or acted
on, defined over the execution's summary tuple (id, stream edge, outcome,
resumable): live flow context in this process gives RUNNING or WAITING;
otherwise `outcome` if present; otherwise "interrupted, checkpoint present".
No write. Today the tuple is read from `meta.json` plus one `stat` of
`flow_<id>.json`; the companion's Stage 2 `executions` row carries the same
columns, so it swaps the source without changing the function.

S1 also deletes the listing-time checkpoint parse. The launcher's history
row and the resume picker advertise "checkpoint present" from one `stat`,
never `classifyRun` (`packages/cli/src/runtime/toolUseResumeData.ts:45`).
Two consequences are deliberate. A `stat` proves existence, not
readability, so the resume path stays the only parser and refuses loudly
on a malformed or legacy no-cursor record (`persistedFlow.ts:423`) instead
of the list pre-filtering it. And the list stops showing `held_elsewhere`:
lease inspection moves to row-open time under S3, so a run another process
holds is discovered when the user opens it, not while scrolling. This is a
deletion, not an index; it creates no file layout for Stage 2 to migrate.

**S2. Terminal facts are written where the run ends.** The one write
repair performs today (record CANCELLED for a crashed run) moves to the
run's own exit paths (SIGINT/SIGTERM teardown already exists in the CLI;
the extension and desktop have deactivate hooks) and, for a hard crash, to
the moment the user resumes that run, the way Codex appends `TurnAborted`
only on resume. An unrepaired row is tolerated by readers, as in OpenCode.

**S3. Ownership is a lock on open-for-write.** Keep `executionLease.ts`
fencing for acquire and resume. Drop `inspectExecutionLease` from any
all-runs path; liveness is proven for the one run the user is opening.
History rows for a run whose lease is held elsewhere show "held" when the
row is opened, not at boot.

**S4. Resumability is a small read.** The contract: `deriveResumability`
reads a small envelope (`schemaVersion`, `cursor`, execution id, outcome
mirror), never the shared-state blob. Delivered by the companion's SQLite
Stage 2 (the `resumable` column) and Stage 5 (the envelope row), not as a
new file beside the blob: a new directory of small files would be a layout
Stage 2 immediately migrates. Conditional on the companion's Stage 0
passing; if it fails, this reverts to the file envelope and the companion
is reopened.

**S5. One index, rebuildable.** The contract: listing never opens
`config.json` or the checkpoint. Delivered by the companion's Stage 2
`executions` and `streams` rows, which also retire `streamLogSummaries/`
and every `listExecutions` scan. Same Stage 0 condition as S4.

**S6. Cleanup is cascade plus TTL, never a boot sweep.** Delete sidecars
with their owning execution at delete time (OpenCode's cascade; the
companion's Stage 4 makes it a row cascade), and run retention as a
deferred, marker-gated background job (Claude Code's `cleanupPeriodDays`).
Orphans then cannot accrue, and the sweep has nothing to do. Retention is
the only mechanism that ever removes the legacy cohort in §6.

**S7. Append, don't rewrite.** Owned by the companion (its Stage 5:
`shared.messages` as appended message rows plus one small envelope row,
inside the event-table-as-truth design). Legacy `flow_<id>.json` records
import eagerly under the companion's single cutover importer, so no live
read arm for the file format survives. Listed here so S1 to S3 are shaped
toward it rather than away from it.

## 6. Migration facts

- 1,133 checkpointed runs in the measured workspace have no `meta.outcome`
  and no `meta.streamId`. They predate stream-id stamping and are never
  repair candidates today; under S1 they read as "interrupted, resumable
  if a checkpoint exists" with a NULL outcome. Neither document proposes a
  backfill, and no importer may synthesize an outcome for them; S6
  retention is the only thing that ever removes them.
- Envelope extraction for existing checkpoints is the companion's Stage 5
  importer, which runs eagerly at cutover (on every open while a legacy
  directory exists, then renames it to `*.pre-sqlite-backup`). No lazy
  read arm and no boot-time backfill outside that importer. If any other
  whole-history pass is ever added it must be one-shot, leased,
  watermarked, and flagged complete, as Codex does.

## 7. What is deliberately not proposed

- A cache in front of restart repair. It would keep the O(history) pass and
  add invalidation.
- Parallelizing phase 2. It would keep per-run lease traffic and the double
  parse.
- Any new lint rule or ratchet. The rule is already written (D3, D7); the
  work is deleting the code that violates it.
