# One writer of loop position

Status: implemented, 2026-09-28 (session format 40). Where the change
departs from the plan below:

- `RunState.phase` stays, as a fold-only fact derived from positions
  (`PHASE_AT` in `runStateFold.ts`), so the loop's resume branches read it
  unchanged. A `halted` position moves no phase: a stop keeps the phase the
  loop stopped in, which is how a resumed run knows whether it stopped
  inside a turn or at a park.
- `model.ready` maps onto `turn.begin`. The per-model-call snapshot that
  wrote `model.ready` is gone; nothing distinguished it from `turn.begin`.
- The round loop's conclusion is a `turn.end` that opens no next round, and
  the fold reads that as `halted`, replacing the `phase: 'halted'`
  snapshot.
- `round` (model calls, read only for debug file names) is counted by the
  fold from each new invocation's `attempt` row, and `run.position` no
  longer carries it.
- A snapshot is written only when the loop state or a runtime field differs
  from the folded one: `snapshotRow` answers an empty list otherwise.

## Two writers today

Every durable move of the run loop is recorded twice, in two vocabularies.

|                       | `run.snapshot` `payload.runtime`                                                                         | `run.position` payload                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Where the loop stands | `phase`: `initial`, `model.ready`, `model.submitted`, `results.ready`, `waiting`, `halted`               | `at`: `turn.ready`, `turn.begin`, `turn.end`, `response.ready`, `results.ready`, `waiting`, `halted` |
| Coordinates           | `round`, `turn` (required)                                                                               | `round`, `turn` (nullish)                                                                            |
| Terminal word         | none (`halted` only)                                                                                     | `outcome` on `halted`                                                                                |
| Also carries          | `modelId`, `modelCompatibilityKey`, `lastError`, `declinedRoutes`, and the loop `state` beside `runtime` | nothing else                                                                                         |

The loop (`src/agent/runtime/loop/rows.ts`: `snapshotRow`, `positionRow`,
`haltedPositionRow`) writes both, usually in the same batch. The turn
boundary in `toolUse.ts` is typical: `snapshot(state, { phase: 'waiting' })`,
then `positionRow(turn.end)`, then `positionRow(waiting)`. There are about 13
snapshot call sites and 13 position call sites across `loop/`,
`FollowUps.ts` and `ModelInvoker.ts`.

## Who reads which

Both rows fold into the loop's own state, `RunState` (`runStateFold.ts`).
`phase`, `round` and `turn` come from the snapshot, and `at` and `outcome`
come from positions through the shared `RunRows` slice.

- **Snapshot `phase` readers:** the loop and resume (`toolUse.ts`:
  initial/waiting/halted checks, the park test at the turn boundary;
  `rounds.ts`; `runProgram.ts` "opened" test; `modelSwitch.ts`),
  `RunLedger` (a run with `phase === null` is unopened), and the CLI's
  `isTerminalWorkflowCheckpoint`, which reads `runtime.phase === 'halted'`
  from `latestSnapshot`.
- **Snapshot coordinate readers:** the loop's own counters, restored on
  resume. `SessionResumeRetrieval` only logs them.
- **Position `at` readers:** the session fold (`sessionFold.withPosition`),
  which derives the live phase (`waiting` parks, anything else runs) and
  `RunView.position`; the loop's resume checks in `toolUse.ts` (is the
  response ready, is the turn ready) and `FollowUps.joinStopped` (is the
  loop halted); and the trace viewer's scrubber, which cuts at position
  rows.
- **Position `outcome` readers:** `RunRows.outcome`, which `rounds.ts` and
  `isTerminalWorkflowCheckpoint` read as the loop's terminal word.

The two phase vocabularies are not a bijection. `model.ready` and
`model.submitted` exist only in the snapshot, and `turn.ready`, `turn.begin`,
`turn.end` and `response.ready` only in positions. Resume code therefore
consults both: `phase` for "parked", `at` for "which half of a turn".

## One writer

`run.position` becomes the only record of where the loop stands, and the
snapshot keeps only what is not position.

- `run.position` carries `at`, `round`, `turn` and, on `halted`, `outcome`.
  Of the two snapshot-only phases, `model.submitted` is never written: the
  fold sets it on a `model.message attempt` row (`runStateFold.ts`), so it
  stays a fold fact. `model.ready` (written with the turn or round bump) is
  what `turn.ready` / `turn.begin` already mark; map it instead of adding a
  value.
- `run.snapshot` loses `runtime.phase`, `runtime.round` and `runtime.turn`,
  and keeps `modelId`, `modelCompatibilityKey`, `lastError`,
  `declinedRoutes` and `state`. It is written only when one of those
  changes, not at every position move.
- `RunState.phase` is derived in the fold from `at`, through one mapping, or
  deleted where its readers can test `at` directly. `RunState.round` and
  `turn` come from positions alone.
- `isTerminalWorkflowCheckpoint` and the "opened" tests read the folded
  position instead of `latestSnapshot().runtime.phase`.

## What gets deleted

- `RunLoopPhaseSchema` and `SnapshotRuntime.phase`, `.round` and `.turn`.
- The patch plumbing that moves `phase` through `snapshotRow`
  (`SnapshotPatch.phase`, and `snapshot(state, { phase })` at every turn
  boundary).
- About half the snapshot writes, the ones that only moved the phase.
- The double check in resume code (`phase` plus `at`).
- The `runtime.round` and `runtime.phase` debug fields in
  `SessionResumeRetrieval`.

## Risk

- **Resume correctness is the risk.** The resume decisions (re-invoke,
  re-dispatch, park, join a stopped response) key on `phase` today. A wrong
  mapping from `at` re-issues a paid request or skips a tool. The existing
  resume suites (`ToolUseWait`, `ToolUseDispatchInterruption`,
  `ResumeToolUseCancellation`, `WorkflowRounds`) cover these paths. PR D
  must keep them green unchanged, and it gets a stop-and-resume E2E at each
  kind of position.
- **Batch preconditions.** `appendBatch` requires a snapshot to be the last
  ledger row of its batch, except for listed followers. That rule changes
  when snapshots stop accompanying every position.
- **Format.** Another `SESSION_EVENT_FORMAT` bump. 1.0 is a clean state, so
  there is no reader for the old format.
- **Listing reads.** `displayProjection.ts` reads the model id from
  snapshots and keeps working, since `modelId` stays. Nothing in the listing
  reads the snapshot phase.
