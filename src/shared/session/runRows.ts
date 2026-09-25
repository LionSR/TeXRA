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
import type {
  FlowStep,
  PermissionPayload,
  RequestDecision,
  RunFamily,
  RunOutcome,
  SessionEvent,
} from '@shared/schemas';

/** The rows this module owns, and the only rows it accepts. */
export type SharedRunRow = Extract<
  SessionEvent,
  {
    type:
      | 'flow.step'
      | 'request.opened'
      | 'request.decided'
      | 'followup.queued'
      | 'followup.consumed';
  }
>;

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
type PendingFollowUp = Pick<
  Extract<SessionEvent, { type: 'followup.queued' }>,
  'followUpId' | 'content'
>;

/**
 * What these rows say about one run. `RunState` is a superset of it, so the
 * loop's fold applies the patch to itself; `sessionFold` keeps one per run
 * beside its view and projects the view's containers from it.
 */
export type RunRows = {
  readonly family: RunFamily | null;
  readonly step: FlowStep | null;
  readonly outcome: RunOutcome | null;
  readonly round: number;
  readonly turn: number;
  readonly continuationIndex: number;
  /** By request id, in the order the rows opened them. */
  readonly requests: Readonly<Record<string, RequestState>>;
  /** Queued without consumed, in commit order. */
  readonly followUps: readonly PendingFollowUp[];
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

/** The slice before any of these rows folded. */
export const freshRunRows = (): RunRows => ({
  family: null,
  step: null,
  outcome: null,
  round: 0,
  turn: 0,
  continuationIndex: 0,
  requests: byId([]),
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

/**
 * Apply one shared row. `current` is `null` for a reader that holds no slice
 * for the run yet: queued input and the loop's own position open one, a
 * request or a consumption presupposes it and moves nothing.
 */
export function applyRunRow(
  current: RunRows | null,
  row: SharedRunRow,
): RunRowVerdict {
  switch (row.type) {
    case 'flow.step': {
      const p = row.payload;
      const rows = current ?? freshRunRows();
      if (rows.family !== null && rows.family !== p.family) {
        return { kind: 'contradiction', detail: 'a step of another family' };
      }
      // A continuation counts within its round: a reflection round opens at
      // continuation 0, so the index is monotone only while the round holds.
      const round = p.round ?? rows.round;
      const coordinates = [
        ['round', p.round],
        ['turn', p.turn],
        [
          'continuationIndex',
          round === rows.round ? p.continuationIndex : null,
        ],
      ] as const;
      for (const [name, value] of coordinates) {
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
        round,
        turn: p.turn ?? rows.turn,
        continuationIndex: p.continuationIndex ?? rows.continuationIndex,
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
      const rows = current ?? freshRunRows();
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
      if (current === null) return { kind: 'unchanged' };
      const followUps = current.followUps.filter(
        (f) => f.followUpId !== row.followUpId,
      );
      const removed = followUps.length !== current.followUps.length;
      if (!removed && current.followUpIds.has(row.followUpId)) {
        return { kind: 'unchanged' };
      }
      return applied({
        ...(removed ? { followUps } : {}),
        followUpIds: new Set([...current.followUpIds, row.followUpId]),
      });
    }
  }
}
