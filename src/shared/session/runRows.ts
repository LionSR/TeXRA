/**
 * The one reducer for the rows both folds read.
 *
 * `runStateFold` produces what the loop continues from and `sessionFold`
 * produces what people see, but five row types carry the same facts to both:
 * the loop's position (`flow.step`), the requests a run has open
 * (`request.opened`, `request.decided`) and the input it has not taken
 * (`followup.queued`, `followup.consumed`). Folding them twice is how a row
 * type lands in one fold and not the other; this module holds the single
 * application, and each fold projects the slice it returns onto its own
 * shape.
 *
 * Pure in the same sense both folds are: no IO, no clock, no platform, no
 * synthetic id. It reports a verdict rather than throwing, because the two
 * readers answer one of them differently: `runStateFold` reads a run's whole
 * aggregate, so a decision naming no request is a malformed aggregate, while
 * `sessionFold` reads whatever the listing, the aggregate or the tail
 * delivered, where the same row means the opening simply never arrived.
 */
import {
  type FlowStep,
  type PermissionPayload,
  type RequestDecision,
  type RoundOutput,
  RUN_PHASE,
  type RunFamily,
  type RunOutcome,
  type RunPhase,
  type SessionEvent,
} from '@shared/schemas';

/** The rows this module owns, and the only rows it accepts. A type listed
 *  here and not handled by `applyRunRow` is a compile error there. */
const SHARED_RUN_ROW_TYPES = {
  'flow.step': true,
  'request.opened': true,
  'request.decided': true,
  'followup.queued': true,
  'followup.consumed': true,
  'output.produced': true,
} as const satisfies Partial<Record<SessionEvent['type'], true>>;

export type SharedRunRow = Extract<
  SessionEvent,
  { type: keyof typeof SHARED_RUN_ROW_TYPES }
>;

/** Whether `applyRunRow` owns this row: the one test both folds branch on. */
export const isSharedRunRow = <E extends SessionEvent>(
  row: E,
): row is Extract<E, SharedRunRow> =>
  Object.hasOwn(SHARED_RUN_ROW_TYPES, row.type);

type RequestState = {
  readonly payload: PermissionPayload;
  /** The earlier request this one continues: an inquiry's multi-turn. */
  readonly thread: string | null;
  readonly resolved: boolean;
  /** The recorded decision (R5): the `request.decided` row's, null while
   *  the request is open. */
  readonly decision: RequestDecision | null;
};

/** A follow-up queued for the run and not yet consumed, as its row holds it. */
export type QueuedFollowUp = Pick<
  Extract<SessionEvent, { type: 'followup.queued' }>,
  'followUpId' | 'content'
>;

/**
 * What these rows say about one run's position: everything but its pending
 * input. `RunState` is a superset of it, so the loop's fold applies the
 * patch to itself.
 */
export type RunPosition = {
  readonly family: RunFamily | null;
  readonly step: FlowStep | null;
  readonly outcome: RunOutcome | null;
  readonly round: number;
  readonly turn: number;
  /** By request id, in the order the rows opened them. */
  readonly requests: Readonly<Record<string, RequestState>>;
  /** Complete output collection from the newest `output.produced` row. */
  readonly roundOutputs: RoundOutput[];
};

/**
 * What these rows say about one run: its position and the input it has not
 * taken. `sessionFold` keeps one per run beside its view and projects the
 * view's containers from it; the admission's replay check reads it whole.
 * The loop's pending input is the publisher's
 * (`SessionEvents.pendingFollowUps`), so `RunState` carries only the
 * position.
 */
export type RunRows = RunPosition & {
  /** Queued without consumed, in commit order. */
  readonly followUps: readonly QueuedFollowUp[];
  /**
   * Every follow-up id a row named, queued or consumed: the unique key. A
   * delivery its producer replays after a restart (#9531) is a second row
   * under an id already here, and it is queued once, never twice.
   */
  readonly followUpIds: ReadonlySet<string>;
};

/**
 * A record keyed by an id the state carries: call and request ids come from
 * outside, so the key `__proto__` is reachable. On a plain object it would
 * hit the inherited setter instead of creating an own entry, and an entry
 * absent from `Object.keys` is a barrier no reader ever sees. Null-prototype,
 * therefore, for every id-keyed record in either fold: one rule, no per-key
 * reasoning about which ids a provider can choose.
 */
export function byId<T>(
  entries: Iterable<readonly [string, T]>,
): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

/** The position before any of these rows folded. */
export const freshRunPosition = (): RunPosition => ({
  family: null,
  step: null,
  outcome: null,
  round: 0,
  turn: 0,
  requests: byId([]),
  roundOutputs: [],
});

/** The slice before any of these rows folded. */
export const freshRunRows = (): RunRows => ({
  ...freshRunPosition(),
  followUps: [],
  followUpIds: new Set(),
});

export type RunRowVerdict =
  | { readonly kind: 'applied'; readonly rows: Partial<RunRows> }
  /** The row moves nothing: an id the slice already carries, or a row that
   *  presupposes a run this reader holds no rows for. */
  | { readonly kind: 'unchanged' }
  /** A decision naming a request the slice does not hold. */
  | { readonly kind: 'unresolved'; readonly requestId: string }
  /** The rows contradict each other under any reader. */
  | { readonly kind: 'contradiction'; readonly detail: string };

const applied = (rows: Partial<RunRows>): RunRowVerdict => ({
  kind: 'applied',
  rows,
});

/** The shared rows that move a run's pending input, not its position. */
type FollowUpRow = Extract<
  SharedRunRow,
  { type: 'followup.queued' | 'followup.consumed' }
>;

export const isFollowUpRow = (row: SessionEvent): row is FollowUpRow =>
  row.type === 'followup.queued' || row.type === 'followup.consumed';

/**
 * Apply one shared row. `current` is `null` for a reader that holds no slice
 * for the run yet: queued input and the loop's own position open one, a
 * request, a consumption or an output presupposes it and moves nothing. A
 * reader that folds only the position (`RunState`) applies only the rows
 * that move it.
 */
export function applyRunRow(
  current: RunPosition | null,
  row: Exclude<SharedRunRow, FollowUpRow>,
): RunRowVerdict;
export function applyRunRow(
  current: RunRows | null,
  row: SharedRunRow,
): RunRowVerdict;
export function applyRunRow(
  current: RunPosition | null,
  row: SharedRunRow,
): RunRowVerdict {
  // A follow-up row enters only through the `RunRows` overload.
  const slice = current as RunRows | null;
  switch (row.type) {
    case 'flow.step': {
      const p = row.payload;
      const rows = current ?? freshRunRows();
      for (const name of ['round', 'turn'] as const) {
        const value = p[name];
        if (value != null && value < rows[name]) {
          return {
            kind: 'contradiction',
            detail: `${name} ${value} is below ${rows[name]}`,
          };
        }
      }
      return applied({
        family: p.family,
        step: p.step,
        round: p.round ?? rows.round,
        turn: p.turn ?? rows.turn,
        outcome: p.step === 'halted' ? (p.outcome ?? null) : rows.outcome,
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
      return applied({
        requests: byId([
          ...Object.entries(current.requests),
          [
            row.requestId,
            {
              payload: row.payload,
              thread: row.thread ?? null,
              resolved: false,
              decision: null,
            },
          ],
        ]),
      });
    }
    case 'request.decided': {
      if (current === null) return { kind: 'unchanged' };
      const request = current.requests[row.requestId];
      if (request === undefined) {
        return { kind: 'unresolved', requestId: row.requestId };
      }
      return applied({
        requests: byId([
          ...Object.entries(current.requests),
          [
            row.requestId,
            { ...request, resolved: true, decision: row.decision },
          ],
        ]),
      });
    }
    case 'followup.queued': {
      // Queued input may precede everything else a run writes, so it opens
      // the slice the way the loop's own first step does. A replayed
      // delivery id is the same follow-up, already queued once.
      const rows = slice ?? freshRunRows();
      if (rows.followUpIds.has(row.followUpId)) return { kind: 'unchanged' };
      return applied({
        followUps: [
          ...rows.followUps,
          { followUpId: row.followUpId, content: row.content },
        ],
        followUpIds: new Set([...rows.followUpIds, row.followUpId]),
      });
    }
    case 'followup.consumed': {
      // The consumer commits this with the message the follow-up became. An
      // id this slice never queued (another writer queued it while the loop
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
      return applied({
        ...(removed ? { followUps } : {}),
        followUpIds: new Set([...slice.followUpIds, row.followUpId]),
      });
    }
    case 'output.produced':
      // Each row carries the run's whole collection: the newest replaces it.
      if (current === null) return { kind: 'unchanged' };
      return applied({ roundOutputs: row.rounds });
  }
}

/**
 * The slice one run's whole committed aggregate folds to: for a reader that
 * holds every row of the run and needs only what these rows say (is this
 * request open, is this follow-up queued), with no `RunState` to build. A
 * whole aggregate answers every decision it holds, so a contradiction or an
 * unresolved decision is a malformed aggregate and throws, as it refuses
 * in `runStateFold`.
 */
export function foldRunRows(rows: readonly SessionEvent[]): RunRows {
  let slice = freshRunRows();
  for (const row of rows) {
    if (!isSharedRunRow(row)) continue;
    const verdict = applyRunRow(slice, row);
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
 * The phase a lifecycle row moves its run to (one run model, 3.3), or null
 * for a row that moves none: an activation and every loop step but
 * `waiting` and `halted` open the run window, `waiting` and a child's park
 * rest it, `run.end` ends it on its outcome. `halted` is the loop's own word
 * and leaves the phase to `run.end`. The one statement of the rule: the
 * session fold's run window, the transcript boundary, the held chunk text
 * and the publisher's open streams all move on it.
 */
export function phaseMoveOf(row: SessionEvent): RunPhase | null {
  switch (row.type) {
    case 'run.activate':
      return RUN_PHASE.RUNNING;
    case 'flow.step':
      if (row.payload.step === 'halted') return null;
      return row.payload.step === 'waiting'
        ? RUN_PHASE.WAITING
        : RUN_PHASE.RUNNING;
    case 'child.park':
      return row.phase === 'parked' ? RUN_PHASE.WAITING : RUN_PHASE.RUNNING;
    case 'run.end':
      return row.outcome;
    default:
      return null;
  }
}

/** Whether the row's phase move rests or ends the run: the move that closes
 *  its run window, every open stream and every held chunk with it. */
export function closesRunWindow(row: SessionEvent): boolean {
  const phase = phaseMoveOf(row);
  return phase !== null && phase !== RUN_PHASE.RUNNING;
}
