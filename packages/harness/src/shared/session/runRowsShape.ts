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
  /** Its parent edge: the `run.start`'s, until a `run.detach` severs it. */
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
  readonly report: string | null;
};
