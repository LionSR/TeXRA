/**
 * The reads of a run's rows, for every reader but the run state and the
 * session view (those apply their shared rows through `runRows.ts`): each
 * read of {@link RUN_ROW_READS} names the kinds it selects and folds those
 * rows, typed as them, into what it answers (`foldRunRows`); a run's record
 * rows fold into its `RunRows` (`runRowsFrom`). Beside them: a row as the
 * decision of a request (`isRequestDecision`), the phase a row moves its run
 * to (`phaseMoveOf`, `closesRunWindow`), and what became of one input
 * (`followUpReceipt`).
 *
 * Pure: no IO, no clock, no platform, no synthetic id.
 */
import {
  type FollowUpReceipt,
  type RunOutcome,
  type RunPosition,
  type SessionEvent,
} from '@shared/schemas';
import { NO_APPROVAL_GRANTS } from '@shared/approvalBypassKind';
import {
  applyRunRow,
  type BatchCopies,
  freshSharedRunRows,
  isSharedRunRow,
  type SharedRunRow,
} from './runRows';
import type { RowOf, RunRows, SharedRunRows } from './runRowsShape';

/** One read: the kinds it selects and what it makes of those rows. */
interface RowRead<K extends SessionEvent['type'], A> {
  readonly kinds: readonly K[];
  readonly fold: (rows: readonly RowOf<K>[]) => A;
}

const rowRead = <const K extends SessionEvent['type'], A>(
  kinds: readonly K[],
  fold: (rows: readonly RowOf<K>[]) => A,
): RowRead<K, A> => ({ kinds, fold });

/**
 * The shared rows among a run's committed rows, applied. A read of a kind
 * holds every row of it, so a contradiction or an unknown request means
 * corrupt history and throws, as `applyRunRows` rejects it.
 */
function sharedRowsFrom(rows: readonly SharedRunRow[]): SharedRunRows {
  let shared = freshSharedRunRows();
  const copies: BatchCopies = new WeakSet();
  for (const row of rows) {
    const verdict = applyRunRow(shared, row, copies);
    if (verdict.kind === 'contradiction' || verdict.kind === 'unresolved') {
      throw new Error(
        `${row.type} on ${row.aggregateId}: ${
          verdict.kind === 'unresolved'
            ? `decision names no request ${verdict.requestId}`
            : verdict.detail
        }`,
      );
    }
    if (verdict.kind === 'applied') shared = { ...shared, ...verdict.rows };
  }
  return shared;
}

/** The key a plugin row kind's latest row is held under. */
const factKey = (row: RowOf<'plugin.fact'>) => `${row.plugin}/${row.kind}`;

/**
 * The reads of a run's rows, by what each answers: its input (`Inbox.read`)
 * with the parent edge and lifecycle that bound it, its requests, its
 * lifecycle rows, the plugin facts of an aggregate (a run's, or a plugin's
 * own), its calls' results, a script's calls with their results, and its
 * positions. A store reads one through its type index and folds it
 * (`SessionLog.runRows`), so no reader names a row kind.
 */
export const RUN_ROW_READS = {
  input: rowRead(
    [
      'followup.queued',
      'followup.consumed',
      'run.start',
      'run.detach',
      'run.activate',
      'run.stop',
      'run.end',
      'followup.closed',
      'run.removed',
    ],
    (rows) => {
      const { parent, end, stop, inputClosed } = runRowsFrom(rows);
      const { followUps, taken } = sharedRowsFrom(rows.filter(isSharedRunRow));
      return { parent, end, stop, inputClosed, followUps, taken };
    },
  ),
  requests: rowRead(['request.opened', 'request.decided'], (rows) => ({
    requests: sharedRowsFrom(rows).requests,
  })),
  lifecycle: rowRead(['run.activate', 'run.end'], (lifecycles) => ({
    lifecycles,
  })),
  facts: rowRead(['plugin.fact'], (rows) => ({
    facts: Object.fromEntries(rows.map((row) => [factKey(row), row])),
  })),
  results: rowRead(['tool.result'], (rows) => ({
    results: rows.map((row) => row.payload),
  })),
  script: rowRead(['script.call', 'tool.result'], (rows) => ({
    scriptCalls: rows.flatMap((row) =>
      row.type === 'script.call' ? [row.payload] : [],
    ),
    results: rows.flatMap((row) =>
      row.type === 'tool.result' ? [row.payload] : [],
    ),
  })),
  positions: rowRead(['run.position'], (positions) => ({ positions })),
};

/** One read of a run's rows: a key of {@link RUN_ROW_READS}. */
export type RunRowRead = keyof typeof RUN_ROW_READS;

/** What read `R` answers. */
export type RunRowsRead<R extends RunRowRead> = ReturnType<
  (typeof RUN_ROW_READS)[R]['fold']
>;

/** Read `read` over `rows`: the rows of its kinds among them, folded. */
export function foldRunRows<R extends RunRowRead>(
  read: R,
  rows: readonly SessionEvent[],
): RunRowsRead<R> {
  const { kinds, fold } = RUN_ROW_READS[read];
  const selected: readonly string[] = kinds;
  // cast: the rows kept are of the read's kinds, which its fold takes;
  // TypeScript cannot tie a generic key to its own entry's parameter.
  return (fold as (rows: readonly SessionEvent[]) => RunRowsRead<R>)(
    rows.filter((row) => selected.includes(row.type)),
  );
}

/** What one record row changes on `rows`. Every kind has a case, so a new
 *  kind does not compile until it is decided here. */
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
      return { activation: row, end: null, stop: null, inputClosed: false };
    case 'run.stop':
      return { stop: row };
    case 'run.end':
      return { end: row };
    case 'followup.closed':
    case 'run.removed':
      return { inputClosed: true };
    case 'run.report':
      return { report: row.report };
    case 'process.exit':
      return { exit: row };
    case 'run.config':
      return { config: row.config };
    case 'run.position':
      return { position: row };
    case 'plugin.fact':
      return { facts: { ...rows.facts, [factKey(row)]: row } };
    case 'run.description': {
      const label = row.by === 'model' ? { label: row } : {};
      // A user's title stands until the user renames again.
      return row.by === 'model' && rows.title?.by === 'user'
        ? label
        : { title: row, ...label };
    }
    // The shared rows (`applyRunRow`), the transcript tier and the run
    // history record nothing here.
    case 'followup.queued':
    case 'followup.consumed':
    case 'request.opened':
    case 'request.decided':
    case 'tool.result':
    case 'script.call':
    case 'log':
    case 'process.output':
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
 * The `RunRows` of a run's record rows: its committed records
 * (`SessionLog.facts`), or the lifecycle rows a read selects. Every other
 * row records nothing.
 */
export function runRowsFrom(rows: readonly SessionEvent[]): RunRows {
  let record: RunRows = {
    start: null,
    parent: null,
    activation: null,
    end: null,
    stop: null,
    inputClosed: false,
    report: null,
    exit: null,
    config: null,
    position: null,
    title: null,
    label: null,
    grants: null,
    facts: {},
  };
  for (const row of rows) record = { ...record, ...recordFacts(record, row) };
  return record;
}

/** Whether `row` decides a request: what a waiter on a request reads off
 *  the tail, and what an export redacts. */
export const isRequestDecision = <R extends Pick<SessionEvent, 'type'>>(
  row: R,
): row is Extract<R, { type: 'request.decided' }> =>
  row.type === 'request.decided';

/** Where a lifecycle row leaves its run: its loop position and outcome. */
export interface PhaseMove {
  readonly position: RunPosition;
  readonly outcome: RunOutcome | null;
}

/**
 * Where a lifecycle row leaves its run, or null for a row that changes
 * neither: an activation and every loop step but `waiting` put it inside a
 * turn, `waiting` between turns, and `run.end` ends it on its outcome,
 * ready for the next activation. The one statement of the rule: the session
 * view's position and outcome, the transcript boundary, the held chunk text
 * and the publisher's open streams all follow it.
 */
export function phaseMoveOf(row: SessionEvent): PhaseMove | null {
  switch (row.type) {
    case 'run.activate':
      return { position: 'running', outcome: null };
    case 'run.position':
      return {
        position: row.payload.at === 'waiting' ? 'waiting' : 'running',
        outcome: null,
      };
    case 'run.end':
      return { position: 'ready', outcome: row.outcome };
    default:
      return null;
  }
}

/** Whether the row rests or ends the run: the change that closes its run
 *  window, every open stream and every held chunk with it. */
export function closesRunWindow(row: SessionEvent): boolean {
  const move = phaseMoveOf(row);
  return move !== null && move.position !== 'running';
}

/** The row kinds a follow-up's receipt reads ({@link followUpReceipt}). */
export const RECEIPT_ROW_TYPES = [
  'followup.queued',
  'followup.consumed',
  'run.position',
  'run.activate',
  'run.stop',
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
  let stop: RowOf<'run.stop'> | null = null;
  for (const row of after) {
    if (row.type === 'run.activate') end = stop = null;
    if (row.type === 'run.stop') stop = row;
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
  return end === null || stop?.reason === 'shutdown'
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
