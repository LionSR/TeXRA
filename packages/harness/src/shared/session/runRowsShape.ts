/**
 * What a run's rows say about it, as `runRows.ts` folds them: the position
 * the run state copies, and the `RunRows` every other reader holds.
 */
import type {
  PermissionPayload,
  PositionAt,
  RequestDecision,
  RunFamily,
  RunOutcome,
  SessionEvent,
} from '@shared/schemas';
import type { ApprovalGrants } from '@shared/approvalBypassKind';
import type { QueuedFollowUp } from './runRows';

type RequestState = {
  readonly payload: PermissionPayload;
  /** The recorded decision: the `request.decided` row's, null while
   *  the request is open. */
  readonly decision: RequestDecision | null;
};

/**
 * What these rows say about one run's position: everything but its pending
 * input. `RunState` has every field of it, so the run state copies the
 * fields `applyRunRow` returns onto itself.
 */
export type RunPosition = {
  readonly family: RunFamily | null;
  readonly at: PositionAt | null;
  readonly outcome: RunOutcome | null;
  readonly turn: number;
  /** By request id, in the order the rows opened them. */
  readonly requests: Readonly<Record<string, RequestState>>;
};

type RowOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;

/**
 * What these rows say about one run: its position and the input it has not
 * taken. The session view keeps one per run and builds its request and
 * follow-up lists from it. The loop reads its pending input from the rows
 * (`Inbox.read`), so `RunState` carries only the position.
 *
 * The fields after `followUpIds` only `runRowsFrom` folds (the view keeps
 * its own on `RunView`), each from the rows its comment names.
 */
export type RunRows = RunPosition & {
  /** Queued without consumed, in commit order. */
  readonly followUps: readonly QueuedFollowUp[];
  /**
   * Every follow-up id a row named, queued or consumed: the unique key. A
   * delivery its producer replays after a restart is a second row
   * under an id already here, and it is queued once, never twice.
   */
  readonly followUpIds: ReadonlySet<string>;
  /** Its `run.start`, and its parent edge: the start's, until a
   *  `run.detach` severs it. */
  readonly start: RowOf<'run.start'> | null;
  readonly parent: RowOf<'run.start'>['parent'];
  /** Its latest `run.activate`, and the `run.end` of the lifecycle that
   *  began (null until it ends): a resumed run never carries an old end. */
  readonly activation: RowOf<'run.activate'> | null;
  readonly end: RowOf<'run.end'> | null;
  /** Its input is closed: the latest of `run.activate`, `followup.closed`
   *  and `run.removed` is not an activation. */
  readonly inputClosed: boolean;
  /** Its `child.park`s in a lifecycle not ended, each with the text of the
   *  latest `run.report` before it. */
  readonly heldParks: readonly { park: RowOf<'child.park'>; text: string }[];
  /** Its latest `run.report`, `run.result`, `run.config` and `run.position`. */
  readonly report: string | null;
  readonly result: RowOf<'run.result'>['result'] | null;
  readonly config: RowOf<'run.config'>['config'] | null;
  readonly position: RowOf<'run.position'> | null;
  /** Its title: the latest user `run.description`, else the latest one. */
  readonly title: RowOf<'run.description'> | null;
  /** Its own grants: the latest `approval.policy`, else the snapshot its
   *  `run.start` carried. */
  readonly grants: ApprovalGrants | null;
  /** Its child turns (`child.turn`), for the report and result slots: the
   *  turn running (or cut short before its delivery ran) and the latest
   *  delivered one, both null before the loop accepted a turn. */
  readonly childTurn: {
    readonly active: AttemptKey | null;
    readonly lastCompleted: AttemptKey | null;
  };
};

/** One child turn's identity: `key` names the child-run attempt that
 *  accepted it and `index` its position in that attempt. */
export interface AttemptKey {
  readonly key: string;
  readonly index: number;
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
