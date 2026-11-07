/**
 * What a run's rows say about it, as `runRows.ts` and `runRowReads.ts` fold
 * them: the position the run state copies, and the `RunRows` every other
 * reader holds.
 */
import type {
  CommitOrdinal,
  FollowUpDisposition,
  PermissionPayload,
  PositionAt,
  RequestDecision,
  RunFamily,
  RunOutcome,
  ScriptCallPayload,
  SessionEvent,
  ToolResultPayload,
} from '@shared/schemas';
import type { ApprovalGrants } from '@shared/approvalBypassKind';
import type { QueuedFollowUp } from './runRows';

type RequestState = {
  readonly payload: PermissionPayload;
  /** The recorded decision: the `request.decided` row's, null while
   *  the request is open. */
  readonly decision: RequestDecision | null;
  /** The `seq` of that `request.decided` row, null while the request is
   *  open: the run's rows order a decision against its activation. */
  readonly decidedAt: number | null;
};

/**
 * What these rows say about one run's position: everything but its pending
 * input. `RunState` has every field of it, so the run state copies the
 * fields `applyRunRow` returns onto itself.
 */
export type RunPosition = {
  readonly family: RunFamily | null;
  /** Where the loop stands. */
  readonly at: PositionAt | null;
  readonly outcome: RunOutcome | null;
  readonly turn: number;
  /** By request id, in the order the rows opened them. */
  readonly requests: Readonly<Record<string, RequestState>>;
};

/** The row of kind `T`. */
export type RowOf<T extends SessionEvent['type']> = Extract<
  SessionEvent,
  { type: T }
>;

/**
 * What these rows say about one run: its position and the input it has not
 * taken. The session view keeps one per run and builds its request and
 * follow-up lists from it. The loop reads its pending input from the rows
 * (`Inbox.read`), so `RunState` carries only the position.
 *
 * The fields after `taken` only `runRowsFrom` sets (the view keeps its
 * own on `RunView`), each from the rows its comment names.
 */
export type RunRows = RunPosition & {
  /** Queued without consumed, in commit order. */
  readonly followUps: readonly QueuedFollowUp[];
  /**
   * Every follow-up a row consumed, by id: why it left the queue and the
   * commit that took it. With `followUps` it is every id a row named, the
   * unique key: a delivery its producer replays after a restart is a second
   * row under an id already queued or taken, and it is queued once, never
   * twice.
   */
  readonly taken: ReadonlyMap<string, TakenFollowUp>;
  /** Its `run.start`, and its parent edge: the start's, until a
   *  `run.detach` severs it. */
  readonly start: RowOf<'run.start'> | null;
  readonly parent: RowOf<'run.start'>['parent'];
  /** Its latest `run.activate`, and the `run.end` of the lifecycle that
   *  began (null until it ends): a resumed run never carries an old end. */
  readonly activation: RowOf<'run.activate'> | null;
  readonly end: RowOf<'run.end'> | null;
  /** The stop asked of this lifecycle (`run.stop`), null until one is:
   *  why the run stopped, or is stopping. */
  readonly stop: RowOf<'run.stop'> | null;
  /** Its deletion marker (`run.removed`), once one landed. */
  readonly removed: RowOf<'run.removed'> | null;
  /** Its input is closed: the latest of `run.activate`, `followup.closed`
   *  and `run.removed` is not an activation. */
  readonly inputClosed: boolean;
  /** Its latest `run.report`, `process.exit`, `run.config` and
   *  `run.position`. */
  readonly report: string | null;
  readonly exit: RowOf<'process.exit'> | null;
  readonly config: RowOf<'run.config'>['config'] | null;
  readonly position: RowOf<'run.position'> | null;
  /** Its title: the latest user `run.description`, else the latest one. */
  readonly title: RowOf<'run.description'> | null;
  /** Its latest model `run.description`, whose priced request (`usage`) is
   *  part of the run's spend whatever title stands. */
  readonly label: RowOf<'run.description'> | null;
  /** Its own grants: the latest `approval.policy`, else the snapshot its
   *  `run.start` carried. */
  readonly grants: ApprovalGrants | null;
  /** Each plugin row kind's latest row, by `plugin/kind` (`plugin.fact`):
   *  read through its plugin's own reader. */
  readonly facts: Readonly<Record<string, RowOf<'plugin.fact'>>>;
  /** The rows a read keeps whole, in seq order, each empty unless the read
   *  selected its kind (`RUN_ROW_READS`): its `run.activate` and `run.end`
   *  rows, its positions, its calls' results, and the calls its scripts
   *  issued. */
  readonly lifecycles: readonly RowOf<'run.activate' | 'run.end'>[];
  readonly positions: readonly RowOf<'run.position'>[];
  readonly results: readonly ToolResultPayload[];
  readonly scriptCalls: readonly ScriptCallPayload[];
};

/** A consumed follow-up: its row's `disposition` and commit. */
interface TakenFollowUp {
  readonly disposition: FollowUpDisposition;
  readonly commit: CommitOrdinal;
}

/** What `applyRunRow` makes of one row. */
export type RunRowVerdict =
  | { readonly kind: 'applied'; readonly rows: Partial<RunRows> }
  /** The row changes nothing: an id already recorded, or a row that needs
   *  a run this reader holds no rows for. */
  | { readonly kind: 'unchanged' }
  /** A decision naming a request this reader does not hold. */
  | { readonly kind: 'unresolved'; readonly requestId: string }
  /** The rows contradict each other under any reader. */
  | { readonly kind: 'contradiction'; readonly detail: string };
