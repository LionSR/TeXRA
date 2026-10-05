/**
 * The run history over the root's event plane: claims and reads through
 * `Database`, writes through `SessionEvents.publish` (the one transaction),
 * `foldRunState` on both paths. Mirrors `sessionEventsLayer`'s placement.
 *
 * Reads use `Database.readAggregate` and `Database.readRunSnapshot`, never
 * `SessionEvents.aggregate`: the latter filters to display rows and would
 * silently drop every run-history-private row.
 */
import { Effect, Layer, Result } from 'effect';

import { PreparedHistorySchema, type ModelOrigin } from '@texra-ai/llm';
import {
  aggregateId as qualifyAggregateId,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  Database,
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { RunHistory, RunHistoryRefused } from '@shared/session/runHistory';
import {
  foldRunState,
  RunHistoryInconsistent,
  unboundRequests,
  type RunHistoryDraft,
  type RunState,
} from '@shared/session/runStateFold';
import type {
  HistoryMessage,
  RunHistoryRow,
} from '@shared/session/historyTurns';
import { SessionEvents } from '@shared/session/sessionEvents';
import { runHistoryRows, storedDraft } from './storedTurn';

/** Rows that may follow a `run.snapshot` in its batch, none moving what it
 *  records, so each folded field has one writer whose last row a resume
 *  reads: positions, card ends, decisions, a parked row's `stream.end`, a
 *  child turn's settlement. */
const AFTER_SNAPSHOT = new Set<RunHistoryDraft['type']>([
  'run.position',
  'tool.end',
  'request.decided',
  'stream.end',
  'run.report',
  'run.result',
  'child.turn',
]);

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

/** The first violated precondition of `appendBatch`, or null. */
function contractViolation(
  run: RunId,
  state: RunState | null,
  rows: readonly RunHistoryDraft[],
  registration: readonly SessionEventDraft[],
): string | null {
  const aggregate = qualifyAggregateId('run', run);
  const settledInBatch = new Map<string, 'success' | 'error'>();
  const hasResponse = rows.some(isResponse);
  if (registration.length > 0) {
    if (state !== null) return 'a registration comes with a run state';
    if (registration[0]?.type !== 'run.start')
      return 'a registration does not start with its run.start';
    const stray = registration.find((row) => row.aggregateId !== aggregate);
    if (stray !== undefined)
      return `a registration's ${stray.type} targets ${stray.aggregateId}, not ${aggregate}`;
  }
  // The writer key is the row's own aggregate while `acquire` and `load` key
  // by the run's, so a row naming another aggregate would fold into the
  // returned live state and be invisible to a reload.
  const foreign = rows.find((row) => row.aggregateId !== aggregate);
  if (foreign !== undefined) {
    return `a ${foreign.type} targets ${foreign.aggregateId}, not ${aggregate}`;
  }
  // The one opening rule, stated here rather than only in `load`: the fold
  // lets a `run.position` or an undelivered `append` land on a fresh run and
  // `load` refuses exactly those rows, so the batch that opens a run carries
  // its `run.snapshot`.
  if (
    (state === null || state.phase === null) &&
    !rows.some((row) => row.type === 'run.snapshot')
  ) {
    return 'a batch on an unopened run carries no opening run.snapshot';
  }
  for (const [index, row] of rows.entries()) {
    if (row.type === 'run.snapshot') {
      const trailing = rows
        .slice(index + 1)
        .find((later) => !AFTER_SNAPSHOT.has(later.type));
      if (trailing !== undefined) {
        return `${trailing.type} follows the run.snapshot of its batch`;
      }
    }
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
    const pending = state?.pendingResponse ?? null;
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
    case 'cancelled':
      return [p.evidence.requestedOrigin];
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
 * query string or fragment. The package's `EndpointSchema` already refuses
 * these at parse time; this is the loud restatement at the one boundary
 * where a row becomes permanent, never a `?? null`. A value that is not a URL
 * at all is refused the same way rather than thrown out of the generator.
 *
 * Returns what the refusal may say, never the rejected endpoint: the part
 * this check exists to keep out of durable state is exactly the part a
 * refusal would otherwise carry into logs and error reports. Scheme, host and
 * path — the components the constraint permits — plus the names of the
 * components that violated it.
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
 * The batch as it would be committed, at provisional commits above the
 * state's. The fold reads a `commit` only to require strict increase and to
 * carry it into the state it returns, so folding these answers "does this
 * batch fold?" exactly as the published rows will, before anything is
 * written.
 */
const candidates = (
  state: RunState | null,
  rows: readonly RunHistoryDraft[],
): readonly RunHistoryRow[] =>
  rows.map((row, index) => ({
    ...row,
    seq: index + 1,
    commit: (state === null ? 0 : state.commit) + index + 1,
    origin: null,
    at: 0,
  }));

/**
 * `PreparedHistorySchema` over `history` from message `from` on. Its rules
 * are between neighbours (a calling assistant and its tool group), so a
 * suffix that starts on a message already checked, and never on a tool
 * group, re-checks every pair past it; a refusal's detail is still the
 * whole parse's, whose indices name the whole history.
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

/** What a lost claim says, from the sequence row that refused the write. */
function notOwnerDetail(failure: DatabaseNotOwner): string {
  if (failure.closed) return 'the run aggregate is closed';
  if (failure.ownerId === null) return 'the claim is unheld';
  return `held by ${failure.ownerId}`;
}

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

/** `load`'s answer for a run's folded rows, which `acquire` shares. */
const loaded = (
  run: RunId,
  folded: ReturnType<typeof foldRunState>,
): Effect.Effect<RunState | null, RunHistoryRefused> =>
  Effect.gen(function* () {
    if (Result.isFailure(folded))
      return yield* inconsistent(run, folded.failure);
    const state = folded.success;
    // Queued follow-ups alone do not open a run: a launch that has not
    // committed its first batch is still the fresh-run branch (`phase` is
    // null). Return that unopened state so the caller can seed pending
    // input; after a restart there is no in-memory copy of those rows.
    if (state === null) return null;
    if (state.phase === null && state.runHistoryRows === 0) return state;
    if (state.phase === null) {
      return yield* inconsistent(
        run,
        new RunHistoryInconsistent({
          reason: 'out-of-order',
          detail: 'run history rows without an opening run.snapshot',
          commit: state.commit,
        }),
      );
    }
    if (state.messages.length > 0) {
      const refusal = unprepared(run, state.messages);
      if (refusal !== null) return yield* refusal;
    }
    return state;
  });

export const runHistoryLayer: Layer.Layer<
  RunHistory,
  never,
  SessionEvents | Database
> = Layer.effect(
  RunHistory,
  Effect.gen(function* () {
    const events = yield* SessionEvents;
    const log = yield* Database;

    // `acquireClaims` proves prior owners dead before moving the claim, and
    // succeeds when this process already holds it. A live foreign owner is a
    // claim verdict (`DatabaseClaimRefused`, carried as the write failure's
    // cause), and a claim another process took after that proof is
    // `DatabaseNotOwner`; those are the refusals that mean `not-owner`, and
    // every other database failure passes through unconverted (F3).
    const acquire = Effect.fn('RunHistory.acquire')(function* (run: RunId) {
      const aggregate = qualifyAggregateId('run', run);
      const taken = yield* log.acquireClaims([aggregate]).pipe(
        Effect.catchTag('DatabaseNotOwner', (failure) =>
          Effect.fail(
            new RunHistoryRefused({
              reason: 'not-owner',
              runId: run,
              detail: notOwnerDetail(failure),
            }),
          ),
        ),
        Effect.mapError((error) =>
          error instanceof DatabaseWriteFailed &&
          error.cause instanceof DatabaseClaimRefused
            ? new RunHistoryRefused({
                reason: 'not-owner',
                runId: run,
                detail: `held by ${error.cause.ownerId} (${error.cause.verdict})`,
              })
            : error,
        ),
      );
      // A tool call's own request is bound to the call (`tool.binding`), so
      // the resume re-enters it; what the previous owner left open unbound
      // is a later request of an attempt already past its first answer,
      // whose body died with that owner. Taking the claim retires exactly
      // those as cancelled, so the surfaces still offering them settle
      // instead of outliving the process that asked. Rows that do not fold
      // are `load`'s refusal, answered here from the same read.
      const stored = yield* log.readAggregate(aggregate, 1);
      // The same read seeds the publisher's pending follow-ups: what an
      // earlier owner left queued is delivered by this one.
      yield* events.hydrateFollowUps(aggregate, taken.length > 0, stored);
      const folded = foldStored(null, stored);
      if (Result.isFailure(folded) || folded.success === null)
        return yield* loaded(run, folded);
      const unbound = unboundRequests(folded.success);
      if (unbound.length === 0) return yield* loaded(run, folded);
      const cancelled = yield* events
        .publish(
          unbound.map((requestId) => ({
            type: 'request.decided' as const,
            aggregateId: aggregate,
            requestId,
            decision: {
              action: 'cancel' as const,
              cause: 'The process that asked exited.',
            },
          })),
        )
        .pipe(
          Effect.catchTag('DatabaseNotOwner', (failure) =>
            Effect.fail(
              new RunHistoryRefused({
                reason: 'not-owner',
                runId: run,
                detail: notOwnerDetail(failure),
              }),
            ),
          ),
        );
      // The cancellations fold onto the same read: the run is read once.
      return yield* loaded(run, foldStored(folded.success, cancelled));
    });

    const latestSnapshot = Effect.fn('RunHistory.latestSnapshot')(function* (
      run: RunId,
    ) {
      return yield* log.readRunSnapshot(qualifyAggregateId('run', run));
    });

    const load = Effect.fn('RunHistory.load')(function* (
      run: RunId,
      through?: number,
    ) {
      const rows = yield* log.readAggregate(qualifyAggregateId('run', run), 1);
      return yield* loaded(
        run,
        foldStored(
          null,
          through === undefined ? rows : rows.filter((r) => r.seq <= through),
        ),
      );
    });

    const appendBatch = Effect.fn('RunHistory.appendBatch')(function* (
      run: RunId,
      state: RunState | null,
      rows: readonly RunHistoryDraft[],
      registration: readonly SessionEventDraft[] = [],
    ) {
      const violation = contractViolation(run, state, rows, registration);
      if (violation !== null) {
        return yield* Effect.die(
          new Error(`RunHistory.appendBatch contract: ${violation}`),
        );
      }
      for (const row of rows) {
        for (const origin of rowOrigins(row)) {
          const unsafe = unsafeEndpoint(origin);
          if (unsafe !== null) {
            return yield* new RunHistoryRefused({
              reason: 'unsafe-endpoint',
              runId: run,
              detail: `a ${row.type} origin is not a scheme, host and path alone: ${unsafe}`,
            });
          }
        }
      }
      // Fold the batch before publishing it. `load` folds the same rows, so a
      // batch that fails an invariant after the transaction has committed
      // leaves a run nothing can read again; the refusal has to arrive while
      // it still means "this batch was not written".
      const candidate = foldRunState(state, candidates(state, rows));
      if (Result.isFailure(candidate)) {
        return yield* inconsistent(run, candidate.failure);
      }
      if (candidate.success === null) {
        return yield* Effect.die(
          new Error(
            'RunHistory.appendBatch contract: a batch on a fresh run appends a run history row',
          ),
        );
      }
      // D11: the history this batch assembles is the history `load` runs
      // through `PreparedHistorySchema`, so every batch that appends to or
      // rewrites it is checked here, where the refusal is still actionable —
      // an edit whose `range` cuts a group, and equally an append
      // that adds an orphan tool group or a call without its results. An
      // empty history goes unchecked, exactly as `load` leaves one unchecked.
      if (
        rows.some(isMessageBearing) &&
        candidate.success.messages.length > 0
      ) {
        // Only what follows the already-checked `state` history is new, or,
        // after an edit (the batch's first message-bearing row), what
        // follows its range's start; re-checking it all is quadratic per run.
        const edit = rows.find((row) => row.type === 'context.edit');
        const held = state?.messages.length ?? 0;
        const kept =
          edit?.type === 'context.edit'
            ? Math.min(edit.payload.range.from, held)
            : held;
        const refusal = unprepared(run, candidate.success.messages, kept);
        if (refusal !== null) return yield* refusal;
      }
      // A target this process no longer holds open is the run history's
      // `not-owner`, nothing written (D6 b, R7); any other rollback stays the
      // write failure it is (F3).
      const committed = yield* events
        .publish([...registration, ...rows.map(storedDraft)])
        .pipe(
          Effect.catchTag('DatabaseNotOwner', (failure) =>
            Effect.fail(
              new RunHistoryRefused({
                reason: 'not-owner',
                runId: run,
                detail: notOwnerDetail(failure),
              }),
            ),
          ),
        );
      // A run registered with its history is its host's to resume, as any
      // parked run is: the claim its birth took here goes back at once. The
      // rows are durable whatever happens to the claim, so a release that
      // fails is no failure of the batch; it says so, and the next process
      // proves this one dead before it takes the claim.
      if (registration.length > 0)
        yield* log
          .releaseClaims([qualifyAggregateId('run', run)])
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Run ${run} was registered with its history, but its claim was not released: this process cannot resume it`,
              ).pipe(Effect.annotateLogs({ data: error })),
            ),
          );
      // The same fold over the same rows, at the commits the publisher
      // actually assigned: that is the state the loop continues from. It
      // differs from the candidate fold only in those ordinals, so a failure
      // here is a defect in this module, not an outcome a caller can act on —
      // and by now the rows are durable, which is what the fold above exists
      // to prevent.
      const folded = foldStored(state, committed);
      if (Result.isFailure(folded) || folded.success === null) {
        return yield* Effect.die(
          new Error(
            `RunHistory.appendBatch published a batch its own fold rejects: ${
              Result.isFailure(folded)
                ? folded.failure.detail
                : 'no run history row folded'
            }`,
          ),
        );
      }
      return folded.success;
    });

    return { acquire, load, latestSnapshot, appendBatch };
  }),
);
