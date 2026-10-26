/**
 * The run history over one session's log, and every run's cell: reads take
 * the aggregate's every row (`SessionLog.rows`, never the display tail),
 * writes go through the session's one door (`SessionLog.transact`, done
 * once the view has applied them) or the job a cell was opened within, and
 * `applyRunRows` rebuilds the state on both paths.
 */
import { Effect, Result, SynchronizedRef } from 'effect';

import {
  qualifyAggregateId,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseNotOwner,
} from '@shared/session/database';
import {
  type RunCell,
  type RunHistory,
  RunHistoryRefused,
  type RunOpening,
  runRefusal,
  runStateAppend,
} from '@shared/session/runHistory';
import {
  applyRunRows,
  freshRunState,
  RunHistoryInconsistent,
  unboundRequests,
  type RunHistoryDraft,
  type RunState,
} from '@shared/session/runState';
import type {
  HistoryMessage,
  RunHistoryRow,
} from '@shared/session/historyTurns';
import type { Alongside, Append } from '@shared/session/sessionEvents';
import { runHistoryRows, storedDraft, unpreparedHistory } from './storedTurn';
import type { ModelOrigin } from '@texra-ai/llm';
import type { SessionLog } from './SessionHandle';

const isResponse = (row: RunHistoryDraft): boolean =>
  row.type === 'model.message' && row.payload.kind === 'response';

/** Rows that append to, or rewrite, the canonical history. */
const isMessageBearing = (row: RunHistoryDraft): boolean =>
  row.type === 'context.edit' ||
  (row.type === 'model.message' &&
    (row.payload.kind === 'append' || row.payload.kind === 'response'));

/**
 * The first violated precondition of `RunCell.append` that only the batch
 * shows, or null. Which row may follow which, a delivery's tool group
 * included, is checked by the row handlers (`applyRunRows`), which
 * `commit` runs the batch through before publishing it.
 */
function contractViolation(
  run: RunId,
  rows: readonly RunHistoryDraft[],
): string | null {
  const aggregate = qualifyAggregateId('run', run);
  // A row naming another aggregate would reach the live state and be
  // invisible to a reload, which reads the run's aggregate.
  const foreign = rows.find((row) => row.aggregateId !== aggregate);
  if (foreign !== undefined) {
    return `a ${foreign.type} targets ${foreign.aggregateId}, not ${aggregate}`;
  }
  const hasResponse = rows.some(isResponse);
  for (const [index, row] of rows.entries()) {
    if (row.type !== 'context.edit') continue;
    const next = rows[index + 1];
    if (hasResponse && (next === undefined || !isResponse(next))) {
      return 'a context.edit is not immediately followed by the response that used it';
    }
    // `range` indexes the history the batch starts from, so no earlier row
    // of the batch may have shifted it.
    if (rows.slice(0, index).some(isMessageBearing)) {
      return 'a context.edit is not the first message-bearing row of its batch';
    }
  }
  return null;
}

/**
 * Every place a `ModelOrigin` binding reaches a durable run history row. The
 * assertion reads these typed positions, never a recursive shape sniff, so an
 * `endpoint` key in tool output or a message body stays data, not a refusal.
 */
function rowOrigins(row: RunHistoryDraft): readonly ModelOrigin[] {
  if (row.type !== 'model.message') return [];
  const p = row.payload;
  switch (p.kind) {
    case 'attempt':
      return [p.origin];
    case 'accepted':
      return [p.operation.origin];
    case 'response': {
      const continuation = p.turn.continuation ?? null;
      return continuation === null
        ? [p.turn.requestedOrigin]
        : [p.turn.requestedOrigin, continuation.origin];
    }
    default:
      return [];
  }
}

/**
 * Every `deployment.endpoint` reaching a run history row carries no userinfo,
 * query string or fragment (`EndpointSchema`'s rule, restated loudly where
 * a row becomes permanent); a non-URL is refused the same way. Returns what
 * the refusal may say: scheme, host and path, and the names of the parts
 * that violated it, never the endpoint the check keeps out of durable state.
 */
function unsafeEndpoint(origin: ModelOrigin): string | null {
  const { endpoint } = origin.deployment;
  if (!URL.canParse(endpoint)) return 'the endpoint is not a URL';
  const url = new URL(endpoint);
  const violations = [
    url.username !== '' || url.password !== '' ? 'userinfo' : null,
    endpoint.includes('?') ? 'a query string' : null,
    endpoint.includes('#') ? 'a fragment' : null,
  ].filter((part): part is string => part !== null);
  return violations.length === 0
    ? null
    : `${url.protocol}//${url.host}${url.pathname} carries ${violations.join(' and ')}`;
}

/**
 * The batch at provisional commits above the state's: the row handlers read
 * a `commit` only to require strict increase, so applying these answers
 * "does this batch apply?" exactly as the published rows will.
 */
const candidates = (
  state: RunState,
  rows: readonly RunHistoryDraft[],
): readonly RunHistoryRow[] =>
  rows.map((row, i) => ({
    ...row,
    ...{ seq: i + 1, commit: state.commit + i + 1, origin: null, at: 0 },
  }));

/**
 * The prepared-history rules over `history` from message `from` on: they
 * are between neighbours, so a suffix starting on a checked message, never
 * on a tool group, re-checks every pair past it; a refusal's detail is still
 * the whole parse's, whose indices name the whole history.
 */
const unprepared = (
  runId: RunId,
  history: readonly HistoryMessage[],
  from = 0,
): RunHistoryRefused | null => {
  let start = Math.max(0, from - 1);
  if (start > 0 && history[start]?.role === 'tool') start -= 1;
  if (unpreparedHistory(history.slice(start)) === null) return null;
  return new RunHistoryRefused({
    reason: 'unprepared-history',
    runId,
    detail: unpreparedHistory(history) ?? `history from message ${start}`,
  });
};

type Refusal = DatabaseNotOwner | DatabaseClaimRefused;
/** A lost claim's refusal, worded by `runRefusal`; any other rollback stays
 *  the write failure it is. */
const notOwner =
  (runId: RunId) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Exclude<E, Refusal> | RunHistoryRefused, R> =>
    Effect.mapError(effect, (failure) =>
      failure instanceof DatabaseClaimRefused ||
      failure instanceof DatabaseNotOwner
        ? runRefusal(runId, failure)
        : // cast: the instanceof tests above ruled both refusals out.
          (failure as Exclude<E, Refusal>),
    );

/** The refusal of rows that cannot be applied. */
const inconsistent = (runId: RunId, cause: RunHistoryInconsistent) =>
  new RunHistoryRefused({
    reason: 'inconsistent',
    runId,
    detail: cause.detail,
    cause,
  });

/** Committed rows applied to `state`, their turns read back first. */
const applyStored = (state: RunState | null, rows: readonly SessionEvent[]) =>
  Result.flatMap(runHistoryRows(rows), (live) => applyRunRows(state, live));

/** `load`'s answer for a run's applied rows, which a resume shares. */
const loaded = Effect.fn('RunHistory.loaded')(function* (
  run: RunId,
  applied: ReturnType<typeof applyRunRows>,
  prepared = true,
): Effect.fn.Return<RunState | null, RunHistoryRefused> {
  if (Result.isFailure(applied))
    return yield* inconsistent(run, applied.failure);
  const state = applied.success;
  // A run's input changes no state; a request before its opening leaves
  // an unopened state (`phase` null).
  if (state === null) return null;
  if (state.phase === null && !state.hasHistoryRows) return state;
  if (state.phase === null) {
    return yield* inconsistent(
      run,
      new RunHistoryInconsistent({
        reason: 'out-of-order',
        detail: 'run history rows without an opening run.position',
        commit: state.commit,
      }),
    );
  }
  if (prepared && state.messages.length > 0) {
    const refusal = unprepared(run, state.messages);
    if (refusal !== null) return yield* refusal;
  }
  return state;
});

/** A batch this module refuses to commit: its caller's defect. */
const broken = (detail: string) =>
  Effect.die(new Error(`RunCell.append contract: ${detail}`));

/** No registration. */
const none: Effect.Effect<readonly SessionEventDraft[]> = Effect.succeed([]);

/** One checked batch, committed in the job `within` names or in the
 *  session's own (`sessionLog`). */
const commit = Effect.fn('RunCell.commit')(function* <E>(
  sessionLog: Pick<SessionLog, 'transact'>,
  run: RunId,
  state: RunState,
  rows: readonly RunHistoryDraft[],
  registration: Effect.Effect<readonly SessionEventDraft[]>,
  alongside: Alongside<E>,
  within: Append | undefined,
) {
  const violation = contractViolation(run, rows);
  if (violation !== null) return yield* broken(violation);
  for (const row of rows)
    for (const unsafe of rowOrigins(row).map(unsafeEndpoint))
      if (unsafe !== null)
        return yield* new RunHistoryRefused({
          reason: 'unsafe-endpoint',
          runId: run,
          detail: `a ${row.type} origin is not a scheme, host and path alone: ${unsafe}`,
        });
  // `load`'s answer with the batch in, before publishing it: a committed
  // batch `load` cannot apply is a run nothing can read again. A delivery
  // its results do not match is the writer's own batch: a defect.
  const batch = applyRunRows(state, candidates(state, rows));
  if (Result.isFailure(batch) && batch.failure.reason === 'mismatched-delivery')
    return yield* broken(batch.failure.detail);
  const after = yield* loaded(run, batch, false);
  // The history `load` checks with `PreparedHistorySchema`, checked here
  // from where the batch changes it (an edit's range start, else the
  // already-checked history's end); re-checking all is quadratic.
  const assembled = after?.messages ?? [];
  if (rows.some(isMessageBearing) && assembled.length > 0) {
    const edit = rows.find((row) => row.type === 'context.edit');
    const held = state.messages.length;
    const kept =
      edit?.type === 'context.edit'
        ? Math.min(edit.payload.range.from, held)
        : held;
    const refusal = unprepared(run, assembled, kept);
    if (refusal !== null) return yield* refusal;
  }
  const target = qualifyAggregateId('run', run);
  const job = (append: Append) =>
    Effect.gen(function* () {
      // Decided in the job, so it reads what the jobs before it left.
      // The store refuses a `run.start` anywhere but a run's first row.
      const born = yield* registration;
      const stray = born.find((row) => row.aggregateId !== target);
      if (stray !== undefined)
        return yield* broken(`a registration targets ${stray.aggregateId}`);
      const beside = yield* alongside;
      const written = yield* runStateAppend(append)([
        ...born,
        ...rows.map(storedDraft),
      ]);
      yield* append(beside);
      return written;
    }).pipe(Effect.scoped);
  // A target no longer held open is `not-owner`, nothing written.
  const committed = yield* (
    within === undefined
      ? sessionLog.transact((tx) => job(tx.append))
      : job(within)
  ).pipe(notOwner(run));
  // The same rows again at the commits the publisher assigned: the state
  // the run continues from. A failure here is this module's defect.
  const applied = applyStored(state, committed);
  if (Result.isSuccess(applied) && applied.success !== null)
    return applied.success;
  const why = Result.isFailure(applied) ? applied.failure.detail : 'nothing';
  return yield* broken(`its own rows reject the published batch: ${why}`);
});

/**
 * One session's run history over its log (`SessionLog`): every row it
 * commits goes through the session's one door, a resume's claim inside the
 * transaction that activates it.
 */
export function makeRunHistory(
  sessionLog: Pick<SessionLog, 'transact' | 'rows'>,
): RunHistory['Service'] {
  const stored = (run: RunId) =>
    sessionLog.rows(qualifyAggregateId('run', run));

  /** `load`, and a read inside a job (`prepared` false: a batch that
   *  changes the history is checked from where it changes). */
  const read = (run: RunId, through = Infinity, prepared = true) =>
    Effect.flatMap(stored(run), (rows) => {
      const kept = rows.filter((r) => r.seq <= through);
      return loaded(run, applyStored(null, kept), prepared);
    });
  const load = Effect.fn('RunHistory.load')((run: RunId, through?: number) =>
    read(run, through),
  );

  /**
   * A resume's one transaction, over one read: the claim (a dead owner's,
   * proved dead, or this process's own), the activation's rows, and the
   * cancellation of the requests no attempt re-enters (`unboundRequests`),
   * so no surface outlives the process that asked.
   */
  const activate = <E>(
    run: RunId,
    activation: NonNullable<RunOpening<E>['activation']>,
  ) =>
    sessionLog
      .transact((tx) =>
        Effect.gen(function* () {
          yield* tx.claim(run);
          const before = yield* loaded(
            run,
            applyStored(null, yield* stored(run)),
          );
          const aggregateId = qualifyAggregateId('run', run);
          const cancels = (before === null ? [] : unboundRequests(before)).map(
            (requestId) => ({
              type: 'request.decided' as const,
              aggregateId,
              requestId,
              decision: {
                action: 'cancel' as const,
                cause: 'The process that asked exited.',
              },
            }),
          );
          const rows = [...(yield* activation(before)), ...cancels];
          const written =
            rows.length === 0 ? [] : yield* runStateAppend(tx.append)(rows);
          return yield* loaded(run, applyStored(before, written));
        }),
      )
      .pipe(notOwner(run));

  const open = Effect.fn('RunHistory.open')(function* <E>(
    run: RunId,
    opening: RunOpening<E> = {},
  ) {
    const { within, activation } = opening;
    const seeded =
      (activation === undefined
        ? yield* read(run, Infinity, within === undefined)
        : yield* activate(run, activation)) ?? freshRunState(0);
    const ref = yield* SynchronizedRef.make(seeded);
    let registration = opening.registration ?? none; // the first append's
    const cell: RunCell = {
      runId: run,
      current: SynchronizedRef.get(ref),
      opened: seeded,
      // A SynchronizedRef: the loop, the invoker and a barrier call run on
      // one fiber, but a parallel partition finishes its calls on sibling
      // fibers, and each call's result must apply on top of the one before.
      append: (rows, alongside = Effect.succeed([])) =>
        SynchronizedRef.updateAndGetEffect(ref, (state) =>
          commit(
            sessionLog,
            run,
            state,
            typeof rows === 'function' ? rows(state) : rows,
            registration,
            alongside,
            within,
          ).pipe(Effect.tap(() => Effect.sync(() => (registration = none)))),
        ).pipe(Effect.uninterruptible),
      refresh: SynchronizedRef.updateAndGetEffect(ref, () =>
        Effect.flatMap(load(run), (state) =>
          state === null
            ? Effect.die(new Error(`Run ${run} lost its rows.`))
            : Effect.succeed(state),
        ),
      ).pipe(Effect.uninterruptible),
    };
    return cell;
  });

  return { load, open };
}
