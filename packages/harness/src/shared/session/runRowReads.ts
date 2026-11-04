/**
 * `RunRows`: what a run's rows say about it, for every reader but the run
 * state and the session view (those apply their shared rows through
 * `runRows.ts`): the fold of the rows one read selects (`runRowsFrom`,
 * `RUN_ROW_READS`), one committed row's own record for a reader of the
 * tail (`recordOf`), a row as the decision of a request
 * (`isRequestDecision`), and the phase a row moves its run to
 * (`phaseMoveOf`, `closesRunWindow`), and what became of one input
 * (`followUpReceipt`). A reader reads these instead of a row's type, so a
 * row kind is decided here once.
 *
 * Pure: no IO, no clock, no platform, no synthetic id.
 */
import {
  RUN_PHASE,
  type FollowUpReceipt,
  type RunPhase,
  type SessionEvent,
} from '@shared/schemas';
import { NO_APPROVAL_GRANTS } from '@shared/approvalBypassKind';
import {
  applyRunRow,
  type BatchCopies,
  freshRunRows,
  isSharedRunRow,
} from './runRows';
import type { RowOf, RunRows } from './runRowsShape';

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

/** What one lifecycle or record row changes on `rows`. Every kind has a
 *  case, so a new kind does not compile until it is decided here. */
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
    case 'run.description': {
      const label = row.by === 'model' ? { label: row } : {};
      // A user's title stands until the user renames again.
      return row.by === 'model' && rows.title?.by === 'user'
        ? label
        : { title: row, ...label };
    }
    case 'child.park': {
      const held = { park: row, text: rows.report ?? '' };
      return {
        park: row,
        ...(rows.end === null && { heldParks: [...rows.heldParks, held] }),
      };
    }
    // The run's model (the session view's), the shared rows
    // (`applyRunRow`), the transcript tier and the run history record
    // nothing here.
    case 'run.model':
    case 'followup.queued':
    case 'followup.consumed':
    case 'request.opened':
    case 'request.decided':
    case 'log':
    case 'stage.start':
    case 'stage.end':
    case 'tool.start':
    case 'tool.end':
    case 'usage':
    case 'context.state':
    case 'stream.start':
    case 'stream.end':
    case 'response.finalized':
    case 'model.message':
    case 'context.edit':
    case 'tool.intent':
    case 'tools.offered':
    case 'context.blob':
    case 'hook.outcome':
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

/** The row kinds a follow-up's receipt reads ({@link followUpReceipt}). */
export const RECEIPT_ROW_TYPES = [
  'followup.queued',
  'followup.consumed',
  'run.position',
  'run.activate',
  'run.end',
  'run.removed',
] as const satisfies readonly SessionEvent['type'][];

/** One input as its run's rows record it: the `followup.queued` row it was
 *  accepted as, and where it stands now. */
export interface FollowUpRecord {
  readonly queued: RowOf<'followup.queued'>;
  readonly receipt: FollowUpReceipt;
}

/**
 * Input `followUpId` of the run whose rows of the {@link RECEIPT_ROW_TYPES}
 * are `rows`, in seq order: `unknown` for an id no row queued, `deleted`
 * for a run deleted since, its inputs with it. A turn's input is answered at that turn's `turn.end` when
 * the turn completed, and unanswered when it failed, or when the run ended
 * with the turn open and no activation followed (a clean close is not an
 * end: the input is still the resumable run's). An activation after the end
 * continues the turn, and its input with it.
 */
export function followUpReceipt(
  rows: readonly SessionEvent[],
  followUpId: string,
): FollowUpRecord | 'unknown' | 'deleted' {
  if (rows.some((row) => row.type === 'run.removed')) return 'deleted';
  const at = rows.findIndex(
    (row) => row.type === 'followup.queued' && row.followUpId === followUpId,
  );
  if (at < 0) return 'unknown';
  // cast: the row `findIndex` matched is a `followup.queued`.
  const queued = rows[at] as RowOf<'followup.queued'>;
  const took = rows.findIndex(
    (row, index) =>
      index > at &&
      row.type === 'followup.consumed' &&
      row.followUpId === followUpId,
  );
  if (took < 0) return { queued, receipt: { state: 'accepted' } };
  // cast: the row `findIndex` matched is a `followup.consumed`.
  const consumed = rows[took] as RowOf<'followup.consumed'>;
  const { disposition } = consumed;
  const receipt = ((): FollowUpReceipt => {
    switch (disposition.kind) {
      case 'answered':
      case 'applied':
        return { state: 'answered', answer: consumed.seq };
      case 'dropped':
        return { state: 'unanswered', reason: disposition.reason };
      case 'turn':
        return turnReceipt(rows.slice(took + 1), disposition.turn);
    }
  })();
  return { queued, receipt };
}

/** Where an input of turn `turn` stands, from the rows after it joined. */
function turnReceipt(
  after: readonly SessionEvent[],
  turn: number,
): FollowUpReceipt {
  let end: RowOf<'run.end'> | null = null;
  for (const row of after) {
    if (row.type === 'run.activate') end = null;
    if (row.type === 'run.end') end = row;
    if (row.type !== 'run.position') continue;
    const { at, outcome } = row.payload;
    const rowTurn = row.payload.turn ?? 0;
    if (at === 'turn.end' && rowTurn === turn)
      return outcome === 'completed'
        ? { state: 'answered', turn, answer: row.seq }
        : { state: 'unanswered', turn, reason: 'failed' };
    // Past the turn with no end of it: the end that cut it short says why.
    if (rowTurn > turn) return unansweredBy(turn, end);
  }
  // A shutdown cut the turn, which the resume continues.
  return end === null || end.reason === 'shutdown'
    ? { state: 'incorporated', turn }
    : unansweredBy(turn, end);
}

/** A turn's input the run's end left unanswered: the end's outcome and
 *  error, or `ended` when no end is in view. */
const unansweredBy = (
  turn: number,
  end: RowOf<'run.end'> | null,
): FollowUpReceipt => ({
  state: 'unanswered',
  turn,
  reason: end?.outcome ?? 'ended',
  ...(end?.error?.message != null && { error: end.error.message }),
});
