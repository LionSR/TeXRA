/**
 * The one function for the rows that both the run state and the session
 * view read.
 *
 * The run state (`runState.ts`) is what the loop continues from and the
 * session view (`sessionViewUpdate.ts`, the session view updater) is what
 * people see. Five row types carry the same facts to both: the loop's
 * position (`run.position`), the requests a run has open (`request.opened`,
 * `request.decided`) and the input it has not taken (`followup.queued`,
 * `followup.consumed`). `applyRunRow` handles each of them once, so a row
 * type cannot reach one reader and miss the other; each reader copies the
 * fields it returns into its own shape.
 *
 * Pure: no IO, no clock, no platform, no synthetic id. It returns a result
 * instead of throwing because the two readers treat a decision for an
 * unknown request differently. The run state reads all of a run's rows, so
 * there it means the history is corrupt. The session view may hold only
 * part of a run's rows (a listing or a tail), so there it means the row that
 * opened the request was not read.
 */
import {
  type PositionAt,
  type PermissionPayload,
  type RequestDecision,
  RUN_PHASE,
  type RunFamily,
  type RunOutcome,
  type RunPhase,
  type SessionEvent,
} from '@shared/schemas';

/** The rows this module owns, and the only rows it accepts. A type listed
 *  here and not handled by `applyRunRow` is a compile error there. */
const SHARED_RUN_ROW_TYPES = {
  'run.position': true,
  'request.opened': true,
  'request.decided': true,
  'followup.queued': true,
  'followup.consumed': true,
} as const satisfies Partial<Record<SessionEvent['type'], true>>;

export type SharedRunRow = Extract<
  SessionEvent,
  { type: keyof typeof SHARED_RUN_ROW_TYPES }
>;

/** Whether `applyRunRow` handles this row: the one test both readers use. */
export const isSharedRunRow = <E extends Pick<SessionEvent, 'type'>>(
  row: E,
): row is Extract<E, SharedRunRow> =>
  Object.hasOwn(SHARED_RUN_ROW_TYPES, row.type);

type RequestState = {
  readonly payload: PermissionPayload;
  /** The recorded decision: the `request.decided` row's, null while
   *  the request is open. */
  readonly decision: RequestDecision | null;
};

/** A follow-up queued for the run and not yet consumed, as its row holds it. */
export type QueuedFollowUp = Pick<
  Extract<SessionEvent, { type: 'followup.queued' }>,
  'followUpId' | 'content' | 'holdUntil' | 'control'
>;

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

/**
 * Where the loop stands, as its own branches read it: between turns
 * (`waiting`, `halted`) or somewhere inside a turn. Never written: derived
 * from the run's `run.position` rows.
 */
export type RunLoopPhase =
  'model.ready' | 'model.submitted' | 'results.ready' | 'waiting' | 'halted';

/**
 * The phase a position leaves an opened loop in. A `halted` position changes
 * none: a stop keeps the phase the loop stopped in, so a resume continues
 * from there. `turn.ready` is input consumed while waiting, still between
 * turns; a `turn.end` that no `waiting` or `turn.begin` follows in its batch
 * is the round loop's last round closed, the run concluded before its
 * terminal row. A run's first position opens it: its opening batch's
 * `turn.ready`, or a fork's `waiting`. A halt opens nothing.
 */
const PHASE_AT: Readonly<Record<Exclude<PositionAt, 'halted'>, RunLoopPhase>> =
  {
    'turn.ready': 'waiting',
    'turn.begin': 'model.ready',
    'response.ready': 'model.submitted',
    'results.ready': 'results.ready',
    'turn.end': 'halted',
    waiting: 'waiting',
  };
export const phaseAfter = (
  phase: RunLoopPhase | null,
  at: PositionAt | null | undefined,
): RunLoopPhase | null =>
  at == null || at === 'halted' ? phase : PHASE_AT[at];

/**
 * What these rows say about one run: its position and the input it has not
 * taken. The session view keeps one per run and builds its request and
 * follow-up lists from it. The loop reads its pending input from the rows
 * (`Inbox.read`), so `RunState` carries only the position.
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
};

/**
 * A record keyed by an id the state carries: call and request ids come from
 * outside, so the key `__proto__` is reachable. On a plain object it would
 * hit the inherited setter instead of creating an own entry, and an entry
 * absent from `Object.keys` is a barrier no reader ever sees. Null-prototype,
 * therefore, for every id-keyed record in either reader: one rule, no
 * per-key reasoning about which ids a provider can choose.
 */
export function byId<T>(
  entries: Iterable<readonly [string, T]>,
): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

/** A fresh null-prototype copy of an id-keyed record. */
export const copyById = <T>(
  record: Readonly<Record<string, T>>,
): Record<string, T> => byId(Object.entries(record));

/**
 * The containers copied while applying one batch of rows. A batch copies a
 * container the first time a row changes it and changes that copy in place
 * afterwards, so a batch costs one copy per container instead of one per
 * row, and nothing reachable from the state the batch started from is ever
 * written. Rebuilding a long run from nothing is one batch; without this,
 * copying its history, contents and call records once per row is quadratic.
 */
export type BatchCopies = WeakSet<object>;

/** `value` itself when this batch already copied it, else a copy the batch
 *  now owns. Without `copies` every change copies, one row at a time. */
export function ownCopy<T extends object, W extends T>(
  copies: BatchCopies | undefined,
  value: T,
  copy: (value: T) => W,
): W {
  // Only `copy` put a value in the set, so an owned value is a `W`.
  if (copies?.has(value) === true) return value as W;
  const fresh = copy(value);
  copies?.add(fresh);
  return fresh;
}

/** The position before any of these rows. */
export const freshRunPosition = (): RunPosition => ({
  family: null,
  at: null,
  outcome: null,
  turn: 0,
  requests: byId([]),
});

/** The `RunRows` before any of these rows. */
export const freshRunRows = (): RunRows => ({
  ...freshRunPosition(),
  followUps: [],
  followUpIds: new Set(),
});

export type RunRowVerdict =
  | { readonly kind: 'applied'; readonly rows: Partial<RunRows> }
  /** The row changes nothing: an id already recorded, or a row that needs
   *  a run this reader holds no rows for. */
  | { readonly kind: 'unchanged' }
  /** A decision naming a request this reader does not hold. */
  | { readonly kind: 'unresolved'; readonly requestId: string }
  /** The rows contradict each other under any reader. */
  | { readonly kind: 'contradiction'; readonly detail: string };

const applied = (rows: Partial<RunRows>): RunRowVerdict => ({
  kind: 'applied',
  rows,
});

/** The shared rows that change a run's pending input, not its position. */
export const FOLLOW_UP_TYPES = [
  'followup.queued',
  'followup.consumed',
] as const;
type FollowUpRow = Extract<
  SharedRunRow,
  { type: (typeof FOLLOW_UP_TYPES)[number] }
>;

const copySet = (ids: ReadonlySet<string>) => new Set(ids);

/**
 * Apply one shared row. `current` is `null` for a reader that holds nothing
 * for the run yet: queued input and the loop's own position start it, while
 * a request or a consumption needs it and changes nothing without it. A
 * reader that keeps only the position (`RunState`) passes only the rows
 * that change it. A reader applying a batch passes its `copies`, and the
 * containers the result carries are then the batch's own, changed in place
 * by later rows of the batch.
 */
export function applyRunRow(
  current: RunPosition | null,
  row: Exclude<SharedRunRow, FollowUpRow>,
  copies?: BatchCopies,
): RunRowVerdict;
export function applyRunRow(
  current: RunRows | null,
  row: SharedRunRow,
  copies?: BatchCopies,
): RunRowVerdict;
export function applyRunRow(
  current: RunPosition | null,
  row: SharedRunRow,
  copies?: BatchCopies,
): RunRowVerdict {
  // A follow-up row enters only through the `RunRows` overload.
  const slice = current as RunRows | null;
  switch (row.type) {
    case 'run.position': {
      const p = row.payload;
      const rows = current ?? freshRunRows();
      if (p.turn != null && p.turn < rows.turn) {
        return {
          kind: 'contradiction',
          detail: `turn ${p.turn} is below ${rows.turn}`,
        };
      }
      return applied({
        family: p.family,
        at: p.at,
        turn: p.turn ?? rows.turn,
        outcome: p.at === 'halted' ? (p.outcome ?? null) : rows.outcome,
      });
    }
    case 'request.opened': {
      if (current === null) return { kind: 'unchanged' };
      if (Object.hasOwn(current.requests, row.requestId)) {
        return {
          kind: 'contradiction',
          detail: `request ${row.requestId} opened twice`,
        };
      }
      const requests = ownCopy(copies, current.requests, copyById);
      requests[row.requestId] = { payload: row.payload, decision: null };
      return applied({ requests });
    }
    case 'request.decided': {
      if (current === null) return { kind: 'unchanged' };
      const request = current.requests[row.requestId];
      if (request === undefined) {
        return { kind: 'unresolved', requestId: row.requestId };
      }
      const requests = ownCopy(copies, current.requests, copyById);
      requests[row.requestId] = { ...request, decision: row.decision };
      return applied({ requests });
    }
    case 'followup.queued': {
      // Queued input may come before everything else a run writes, so it
      // starts the reader's state; a replayed delivery id is queued once.
      const rows = slice ?? freshRunRows();
      if (rows.followUpIds.has(row.followUpId)) return { kind: 'unchanged' };
      const followUps = ownCopy(copies, rows.followUps, (f) => [...f]);
      followUps.push({
        followUpId: row.followUpId,
        content: row.content,
        ...(row.holdUntil ? { holdUntil: row.holdUntil } : {}),
        ...(row.control ? { control: row.control } : {}),
      });
      const followUpIds = ownCopy(copies, rows.followUpIds, copySet);
      followUpIds.add(row.followUpId);
      return applied({ followUps, followUpIds });
    }
    case 'followup.consumed': {
      // The consumer commits this with the message the follow-up became. An
      // id this reader never queued (another writer queued it while the loop
      // ran, or the read that delivered this row did not carry the queuing)
      // consumes nothing, and is recorded so the queuing cannot land twice.
      if (slice === null) return { kind: 'unchanged' };
      const followUps = slice.followUps.filter(
        (f) => f.followUpId !== row.followUpId,
      );
      const removed = followUps.length !== slice.followUps.length;
      if (!removed && slice.followUpIds.has(row.followUpId)) {
        return { kind: 'unchanged' };
      }
      if (removed) copies?.add(followUps);
      const followUpIds = ownCopy(copies, slice.followUpIds, copySet);
      followUpIds.add(row.followUpId);
      return applied({ ...(removed ? { followUps } : {}), followUpIds });
    }
  }
}

/**
 * The `RunRows` of one run's whole committed aggregate, for a reader that
 * holds every row of the run and needs only what these rows say (is this
 * request open, is this follow-up queued) without building a `RunState`.
 * A whole aggregate answers every decision it holds, so a contradiction or
 * an unknown request means corrupt history and throws, as `applyRunRows`
 * rejects it.
 */
export function runRowsFrom(rows: readonly SessionEvent[]): RunRows {
  let slice = freshRunRows();
  const copies: BatchCopies = new WeakSet();
  for (const row of rows) {
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
