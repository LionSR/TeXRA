/**
 * `RunRows`: what a run's rows say about it, for every reader but the run
 * state and the session view (those apply their shared rows through
 * `runRows.ts`): the fold of the rows one read selects (`runRowsFrom`,
 * `RUN_ROW_READS`), one committed row's own record for a reader of the
 * tail (`recordOf`), a row as the decision of a request
 * (`isRequestDecision`), and the phase a row moves its run to
 * (`phaseMoveOf`, `closesRunWindow`). A reader reads these instead of a
 * row's type, so a row kind is decided here once.
 *
 * Pure: no IO, no clock, no platform, no synthetic id.
 */
import { RUN_PHASE, type RunPhase, type SessionEvent } from '@shared/schemas';
import { NO_APPROVAL_GRANTS } from '@shared/approvalBypassKind';
import {
  applyRunRow,
  type BatchCopies,
  freshRunRows,
  isSharedRunRow,
} from './runRows';
import type { RunRows } from './runRowsShape';

/**
 * The kinds each read of a run folds, by what it reads: its input
 * (`Inbox.read`), its parks with the lifecycle that bounds them, its
 * requests, its child turns, its lifecycle rows, the plugin facts of an
 * aggregate (a run's, or a plugin's own), its calls' results, a script's
 * calls with their results, and its positions. A store reads one through
 * its type index and folds it (`SessionLog.runRows`), so no reader names a
 * row kind.
 */
export const RUN_ROW_READS = {
  input: [
    'followup.queued',
    'followup.consumed',
    'run.start',
    'run.detach',
    'run.activate',
    'run.end',
    'followup.closed',
    'run.removed',
  ],
  parks: ['child.park', 'run.report', 'run.activate', 'run.end'],
  requests: ['request.opened', 'request.decided'],
  turns: ['child.turn'],
  lifecycle: ['run.activate', 'run.end'],
  facts: ['plugin.fact'],
  results: ['tool.result'],
  script: ['script.call', 'tool.result'],
  positions: ['run.position'],
} as const satisfies Record<string, readonly SessionEvent['type'][]>;

/** One read of a run's rows: a key of {@link RUN_ROW_READS}. */
export type RunRowRead = keyof typeof RUN_ROW_READS;

/** What one lifecycle or record row changes on `rows`. */
function recordFacts(rows: RunRows, row: SessionEvent): Partial<RunRows> {
  switch (row.type) {
    case 'run.start': {
      const grants = row.approvalPolicy ?? NO_APPROVAL_GRANTS;
      return { start: row, parent: row.parent, grants };
    }
    case 'approval.policy':
      return { grants: row.snapshot };
    case 'run.detach':
      return { parent: null };
    case 'run.activate':
      return {
        activation: row,
        end: null,
        inputClosed: false,
        heldParks: [],
        lifecycles: [...rows.lifecycles, row],
      };
    case 'run.end':
      return { end: row, heldParks: [], lifecycles: [...rows.lifecycles, row] };
    case 'followup.closed':
      return { inputClosed: true };
    case 'run.removed':
      return { inputClosed: true, removed: row };
    case 'run.report':
      return { report: row.report };
    case 'run.result':
      return { result: row.result };
    case 'run.config':
      return { config: row.config };
    case 'run.position':
      return { position: row, positions: [...rows.positions, row] };
    case 'tool.result':
      return { results: [...rows.results, row.payload] };
    case 'script.call':
      return { scriptCalls: [...rows.scriptCalls, row.payload] };
    case 'plugin.fact':
      return { facts: { ...rows.facts, [`${row.plugin}/${row.kind}`]: row } };
    case 'child.turn': {
      // `accepted` opens a turn; `settled` closes it, maybe an earlier one.
      const turn = { key: row.attemptId, index: row.turnIndex };
      const { active, lastCompleted } = rows.childTurn;
      const closes = active?.key === turn.key && active.index === turn.index;
      return row.phase === 'settled'
        ? { childTurn: { active: closes ? null : active, lastCompleted: turn } }
        : { childTurn: { active: turn, lastCompleted } };
    }
    case 'run.description':
      // A user's title stands until the user renames again.
      return row.by === 'model' && rows.title?.by === 'user'
        ? {}
        : { title: row };
    case 'child.park': {
      const held = { park: row, text: rows.report ?? '' };
      return {
        park: row,
        ...(rows.end === null && { heldParks: [...rows.heldParks, held] }),
      };
    }
    default:
      return {};
  }
}

/**
 * The `RunRows` of one run's committed aggregate (or the kinds a reader
 * needs), for a reader that needs only what these rows say (is this
 * request open, is this follow-up queued) without building a `RunState`.
 * A whole aggregate answers every decision it holds, so a contradiction or
 * an unknown request means corrupt history and throws, as `applyRunRows`
 * rejects it.
 */
export function runRowsFrom(rows: readonly SessionEvent[]): RunRows {
  let slice = freshRunRows();
  const copies: BatchCopies = new WeakSet();
  for (const row of rows) {
    slice = { ...slice, ...recordFacts(slice, row) };
    if (!isSharedRunRow(row)) continue;
    const verdict = applyRunRow(slice, row, copies);
    if (verdict.kind === 'contradiction' || verdict.kind === 'unresolved') {
      throw new Error(
        `${row.type} on ${row.aggregateId}: ${
          verdict.kind === 'unresolved'
            ? `decision names no request ${verdict.requestId}`
            : verdict.detail
        }`,
      );
    }
    if (verdict.kind === 'applied') slice = { ...slice, ...verdict.rows };
  }
  return slice;
}

/**
 * What one committed row says on its own: the `RunRows` after that row
 * alone, for a reader of the tail that acts on a row's arrival (a run's
 * end, its removal, a child's held park, a delivery to a parent). A
 * request's decision and a follow-up's consumption say nothing alone: what
 * they answer is not here.
 */
export function recordOf(row: SessionEvent): RunRows {
  const fresh = freshRunRows();
  const rows = { ...fresh, ...recordFacts(fresh, row) };
  if (!isSharedRunRow(row)) return rows;
  const verdict = applyRunRow(rows, row);
  return verdict.kind === 'applied' ? { ...rows, ...verdict.rows } : rows;
}

/** Whether `row` decides a request: what a waiter on a request reads off
 *  the tail, and what an export redacts. */
export const isRequestDecision = <R extends Pick<SessionEvent, 'type'>>(
  row: R,
): row is Extract<R, { type: 'request.decided' }> =>
  row.type === 'request.decided';

/**
 * The phase a lifecycle row puts its run in, or null for a row that changes
 * none: an activation and every loop step but `waiting` and `halted` open
 * the run window, `waiting` and a child's wait rest it, `run.end` ends it on
 * its outcome. `halted` is the loop's own word and leaves the phase to
 * `run.end`. The one statement of the rule: the session view's run window,
 * the transcript boundary, the held chunk text and the publisher's open
 * streams all follow it.
 */
export function phaseMoveOf(row: SessionEvent): RunPhase | null {
  switch (row.type) {
    case 'run.activate':
      return RUN_PHASE.RUNNING;
    case 'run.position':
      if (row.payload.at === 'halted') return null;
      return row.payload.at === 'waiting'
        ? RUN_PHASE.WAITING
        : RUN_PHASE.RUNNING;
    case 'child.park':
      return row.phase === 'resumed' ? RUN_PHASE.RUNNING : RUN_PHASE.WAITING;
    case 'run.end':
      return row.outcome;
    default:
      return null;
  }
}

/** Whether the row's phase rests or ends the run: the change that closes
 *  its run window, every open stream and every held chunk with it. */
export function closesRunWindow(row: SessionEvent): boolean {
  const phase = phaseMoveOf(row);
  return phase !== null && phase !== RUN_PHASE.RUNNING;
}
