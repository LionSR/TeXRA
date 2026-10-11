/**
 * The run history over one session's log, and every run's cell: reads take
 * the aggregate's every row (`SessionLog.rows`, never the display tail),
 * writes go through the session's one door (`SessionLog.transact`, settled
 * once the view folded them) or the job a cell was opened within, and
 * `foldRunState` runs on both paths.
 */
import { Effect, Result, type Scope, SynchronizedRef } from 'effect';

import { PreparedHistorySchema, type ModelOrigin } from '@texra-ai/llm';
import {
  aggregateId as qualifyAggregateId,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
import {
  type RunCell,
  type RunHistory,
  RunHistoryRefused,
  type RunOpening,
  runStateAppend,
} from '@shared/session/runHistory';
import {
  foldRunState,
  freshRunState,
  RunHistoryInconsistent,
  unboundRequests,
  type RunHistoryDraft,
  type RunState,
} from '@shared/session/runStateFold';
import type {
  HistoryMessage,
  RunHistoryRow,
} from '@shared/session/historyTurns';
import {
  afterCommit,
  noCoWrite,
  type Append,
  type CoWrite,
} from '@shared/session/sessionEvents';
import { runHistoryRows, storedDraft } from './storedTurn';
import type { SessionLog } from './SessionHandle';

const isResponse = (row: RunHistoryDraft): boolean =>
  row.type === 'model.message' && row.payload.kind === 'response';

/** Rows that append to, or rewrite, the canonical history. */
const isMessageBearing = (row: RunHistoryDraft): boolean =>
  row.type === 'context.edit' ||
  (row.type === 'model.message' &&
    (row.payload.kind === 'append' || row.payload.kind === 'response'));

/** The provider-side status a settled call reports in its tool group. */
const settlementStatus = (status: 'executed' | 'error'): 'success' | 'error' =>
  status === 'executed' ? 'success' : 'error';

/** The first violated precondition of `RunCell.append`, or null. */
function contractViolation(
  run: RunId,
  state: RunState,
  rows: readonly RunHistoryDraft[],
): string | null {
  const aggregate = qualifyAggregateId('run', run);
  const settledInBatch = new Map<string, 'success' | 'error'>();
  const hasResponse = rows.some(isResponse);
  // A row naming another aggregate would fold into the live state and be
  // invisible to a reload, which reads the run's aggregate.
  const foreign = rows.find((row) => row.aggregateId !== aggregate);
  if (foreign !== undefined) {
    return `a ${foreign.type} targets ${foreign.aggregateId}, not ${aggregate}`;
  }
  for (const [index, row] of rows.entries()) {
    if (row.type === 'context.edit') {
      if (hasResponse) {
        const next = rows[index + 1];
        if (next === undefined || !isResponse(next)) {
          return 'a context.edit is not immediately followed by the response that used it';
        }
      }
      // `range` indexes the history the batch starts from, so no earlier
      // row of the batch may have shifted it.
      if (rows.slice(0, index).some(isMessageBearing)) {
        return 'a context.edit is not the first message-bearing row of its batch';
      }
    }
    if (row.type === 'tool.result') {
      settledInBatch.set(
        `${row.payload.responseId}/${row.payload.callId}`,
        settlementStatus(row.payload.result.status),
      );
    }
    if (row.type !== 'model.message' || row.payload.kind !== 'append') {
      continue;
    }
    const { sourceResponse, messages } = row.payload;
    if (sourceResponse === null) continue;
    const pending = state.pendingResponse;
    if (pending === null || pending.responseId !== sourceResponse) {
      return `a delivering append names ${sourceResponse}, which is not the pending response`;
    }
    const group = messages[0];
    if (group === undefined || group.role !== 'tool') {
      return 'a delivering append does not start with a tool group';
    }
    if (group.results.length !== pending.calls.length) {
      return `the tool group carries ${group.results.length} results for ${pending.calls.length} calls`;
    }
    for (const [ordinal, call] of pending.calls.entries()) {
      const result = group.results[ordinal];
      if (result === undefined || result.callOrdinal !== ordinal) {
        return `the tool group carries no result at ordinal ${ordinal}`;
      }
      const settled = pending.records[call.callId]?.status;
      const expected =
        settled?.kind === 'settled'
          ? settlementStatus(settled.result.status)
          : settledInBatch.get(`${pending.responseId}/${call.callId}`);
      if (expected === undefined) {
        return `call ${call.callId} has no committed settlement`;
      }
      if (result.status !== expected) {
        return `ordinal ${ordinal} reports ${result.status} for an ${expected} settlement`;
      }
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
      const continuation =
        p.turn.kind === 'http' ? (p.turn.continuation ?? null) : null;
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
  if (origin.protocol === 'vscode-lm') return null;
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
 * The batch at provisional commits above the state's: the fold reads a
 * `commit` only to require strict increase, so folding these answers "does
 * this batch fold?" exactly as the published rows will.
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
 * `PreparedHistorySchema` over `history` from message `from` on: its rules
 * are between neighbours, so a suffix starting on a checked message, never
 * on a tool group, re-checks every pair past it.
 */
const unprepared = (
  runId: RunId,
  history: readonly HistoryMessage[],
  from = 0,
): RunHistoryRefused | null => {
  let start = Math.max(0, from - 1);
  if (start > 0 && history[start]?.role === 'tool') start -= 1;
  if (PreparedHistorySchema.safeParse(history.slice(start)).success)
    return null;
  return new RunHistoryRefused({
    reason: 'unprepared-history',
    runId,
    detail:
      PreparedHistorySchema.safeParse(history).error?.message ??
      `history from message ${start}`,
  });
};

/** A lost claim's refusal, worded from the refusing row; any other
 *  rollback stays the write failure it is (F3). */
const notOwner =
  (runId: RunId) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Exclude<E, DatabaseNotOwner> | RunHistoryRefused, R> =>
    Effect.mapError(effect, (failure) => {
      // A live foreign owner refusing a claim is the same refusal.
      if (
        failure instanceof DatabaseWriteFailed &&
        failure.cause instanceof DatabaseClaimRefused
      ) {
        const { ownerId, verdict } = failure.cause;
        const detail = `held by ${ownerId} (${verdict})`;
        return new RunHistoryRefused({ reason: 'not-owner', runId, detail });
      }
      if (!(failure instanceof DatabaseNotOwner))
        // cast: the instanceof test above ruled DatabaseNotOwner out.
        return failure as Exclude<E, DatabaseNotOwner>;
      let detail = `held by ${failure.ownerId}`;
      if (failure.ownerId === null) detail = 'the claim is unheld';
      if (failure.closed) detail = 'the run aggregate is closed';
      return new RunHistoryRefused({ reason: 'not-owner', runId, detail });
    });

/** The refusal of rows that do not fold. */
const inconsistent = (runId: RunId, cause: RunHistoryInconsistent) =>
  new RunHistoryRefused({
    reason: 'inconsistent',
    runId,
    detail: cause.detail,
    cause,
  });

/** Committed rows folded onto `state`, their turns read back first. */
const foldStored = (state: RunState | null, rows: readonly SessionEvent[]) =>
  Result.flatMap(runHistoryRows(rows), (live) => foldRunState(state, live));

/** `load`'s answer for a run's folded rows, which a resume shares. */
const loaded = (
  run: RunId,
  folded: ReturnType<typeof foldRunState>,
  prepared = true,
): Effect.Effect<RunState | null, RunHistoryRefused> =>
  Effect.gen(function* () {
    if (Result.isFailure(folded))
      return yield* inconsistent(run, folded.failure);
    const state = folded.success;
    // A run's input folds nothing; a request before its opening folds an
    // unopened state (`phase` null).
    if (state === null) return null;
    if (state.phase === null && state.runHistoryRows === 0) return state;
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
    Effect.flatMap(stored(run), (rows) =>
      loaded(
        run,
        foldStored(
          null,
          rows.filter((r) => r.seq <= through),
        ),
        prepared,
      ),
    );
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
            foldStored(null, yield* stored(run)),
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
          return yield* loaded(run, foldStored(before, written));
        }),
      )
      .pipe(notOwner(run));

  /** One checked batch, committed in the job `within` names or in its own. */
  const commit = Effect.fn('RunCell.commit')(function* <E>(
    run: RunId,
    state: RunState,
    rows: readonly RunHistoryDraft[],
    registration: Effect.Effect<readonly SessionEventDraft[]>,
    alongside: Effect.Effect<CoWrite, E, Scope.Scope>,
    within: Append | undefined,
  ) {
    const violation = contractViolation(run, state, rows);
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
    // batch `load` cannot fold is a run nothing can read again.
    const after = yield* loaded(
      run,
      foldRunState(state, candidates(state, rows)),
      false,
    );
    // D11: the history `load` checks with `PreparedHistorySchema`, checked
    // here from what the batch changes on (an edit's range start, else the
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
        const co = yield* alongside;
        const written = yield* runStateAppend(append)([
          ...born,
          ...rows.map(storedDraft),
        ]);
        yield* append(co.rows);
        yield* afterCommit(co.committed);
        return written;
      }).pipe(Effect.scoped);
    // A target no longer held open is `not-owner`, nothing written (R7).
    const committed = yield* (
      within === undefined
        ? sessionLog.transact((tx) => job(tx.append))
        : job(within)
    ).pipe(notOwner(run));
    // The same fold at the commits the publisher assigned: the state the run
    // continues from. A failure here is this module's defect.
    const folded = foldStored(state, committed);
    if (Result.isSuccess(folded) && folded.success !== null)
      return folded.success;
    const why = Result.isFailure(folded) ? folded.failure.detail : 'nothing';
    return yield* broken(`its own fold rejects the published batch: ${why}`);
  });

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
      // one fiber, but a parallel partition settles its calls on sibling
      // fibers, and each settlement must fold onto the one before it.
      append: (rows, alongside = noCoWrite) =>
        SynchronizedRef.updateAndGetEffect(ref, (state) =>
          commit(
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
