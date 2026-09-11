/**
 * The run ledger over the root's event plane: claims and reads through
 * `Database`, writes through `SessionEvents.publish` (the one transaction),
 * `foldRunState` on both paths. Mirrors `sessionEventsLayer`'s placement.
 *
 * Reads use `Database.readAggregate`, never `SessionEvents.aggregate`: the
 * latter filters to display rows and would silently drop every
 * ledger-private row.
 */
import { Effect, Layer, Result } from 'effect';

import {
  PreparedHistorySchema,
  type MessageSchema,
  type ModelOrigin,
} from '@llm/turn';
import {
  aggregateId as qualifyAggregateId,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  Database,
  DatabaseClaimRefused,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import {
  foldRunState,
  RunLedgerInconsistent,
  type RunLedgerDraft,
  type RunState,
} from '@shared/session/runStateFold';
import { SessionEvents } from '@shared/session/sessionEvents';
import type { z } from 'zod';

/** Rows that may follow a `flow.snapshot` in its batch. */
const AFTER_SNAPSHOT = new Set<RunLedgerDraft['type']>([
  'flow.step',
  'tool.end',
  'approval.requested',
  'approval.resolved',
]);

const isResponse = (row: RunLedgerDraft): boolean =>
  row.type === 'model.message' && row.payload.kind === 'response';

/** Rows that append to, or rewrite, the canonical history. */
const isMessageBearing = (row: RunLedgerDraft): boolean =>
  row.type === 'model.compaction' ||
  (row.type === 'model.message' &&
    (row.payload.kind === 'append' || row.payload.kind === 'response'));

/** The provider-side status a settled call reports in its tool group. */
const settlementStatus = (status: 'executed' | 'error'): 'success' | 'error' =>
  status === 'executed' ? 'success' : 'error';

/** The first violated precondition of `appendBatch`, or null. */
function contractViolation(
  run: RunId,
  state: RunState | null,
  rows: readonly RunLedgerDraft[],
): string | null {
  const aggregate = qualifyAggregateId('run', run);
  const settledInBatch = new Map<string, 'success' | 'error'>();
  const hasResponse = rows.some(isResponse);
  // The writer key is the row's own aggregate while `acquire` and `load` key
  // by the run's, so a row naming another aggregate would fold into the
  // returned live state and be invisible to a reload.
  const foreign = rows.find((row) => row.aggregateId !== aggregate);
  if (foreign !== undefined) {
    return `a ${foreign.type} targets ${foreign.aggregateId}, not ${aggregate}`;
  }
  // The one opening rule, stated here rather than only in `load`: the fold
  // lets a `flow.step` or an undelivered `append` land on a fresh run and
  // `load` refuses exactly those rows, so the batch that opens a run carries
  // its `flow.snapshot`.
  if (
    (state === null || state.phase === null) &&
    !rows.some((row) => row.type === 'flow.snapshot')
  ) {
    return 'a batch on an unopened run carries no opening flow.snapshot';
  }
  for (const [index, row] of rows.entries()) {
    if (row.type === 'flow.snapshot') {
      const trailing = rows
        .slice(index + 1)
        .find((later) => !AFTER_SNAPSHOT.has(later.type));
      if (trailing !== undefined) {
        return `${trailing.type} follows the flow.snapshot of its batch`;
      }
    }
    if (row.type === 'model.compaction') {
      if (hasResponse) {
        const next = rows[index + 1];
        if (next === undefined || !isResponse(next)) {
          return 'a model.compaction is not immediately followed by the response that used it';
        }
      }
      // `keepPrefix` indexes the history the batch starts from, so no earlier
      // row of the batch may have shifted it.
      if (rows.slice(0, index).some(isMessageBearing)) {
        return 'a model.compaction is not the first message-bearing row of its batch';
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
      const settlement = pending.settled[call.callId];
      const expected =
        settlement === undefined
          ? settledInBatch.get(`${pending.responseId}/${call.callId}`)
          : settlementStatus(settlement.result.status);
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
 * The typed origin positions of a ledger row: every place a `ModelOrigin`
 * binding reaches a durable row. An assertion over these positions, never a
 * recursive shape sniff, so an `endpoint` key inside tool output or a message
 * body stays data rather than becoming a refusal.
 */
function rowOrigins(row: RunLedgerDraft): readonly ModelOrigin[] {
  if (row.type === 'model.compaction') {
    const { continuation } = row.payload;
    return continuation === null ? [] : [continuation.origin];
  }
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
 * Every `deployment.endpoint` reaching a ledger row carries no userinfo,
 * query string or fragment. The package's `EndpointSchema` already refuses
 * these at parse time; this is the loud restatement at the one boundary
 * where a row becomes permanent, never a `?? null`. A value that is not a URL
 * at all is refused the same way rather than thrown out of the generator.
 */
function unsafeEndpoint(origin: ModelOrigin): string | null {
  if (origin.protocol === 'vscode-lm') return null;
  const { endpoint } = origin.deployment;
  if (!URL.canParse(endpoint)) return endpoint;
  const url = new URL(endpoint);
  return url.username !== '' || url.password !== '' || /[?#]/.test(endpoint)
    ? endpoint
    : null;
}

const unprepared = (
  runId: RunId,
  history: readonly z.output<typeof MessageSchema>[],
): RunLedgerRefused | null => {
  const prepared = PreparedHistorySchema.safeParse(history);
  return prepared.success
    ? null
    : new RunLedgerRefused({
        reason: 'unprepared-history',
        runId,
        detail: prepared.error.message,
      });
};

export const runLedgerLayer: Layer.Layer<
  RunLedger,
  never,
  SessionEvents | Database
> = Layer.effect(
  RunLedger,
  Effect.gen(function* () {
    const events = yield* SessionEvents;
    const log = yield* Database;

    // `acquireClaims` proves prior owners dead before moving the claim, and
    // succeeds when this process already holds it. A live foreign owner is a
    // claim verdict (`DatabaseClaimRefused`, carried as the write failure's
    // cause), which is the one write failure that means `not-owner`; every
    // other database failure passes through unconverted (F3).
    const acquire = Effect.fn('RunLedger.acquire')(function* (run: RunId) {
      yield* log.acquireClaims([qualifyAggregateId('run', run)]).pipe(
        Effect.mapError((error) =>
          error instanceof DatabaseWriteFailed &&
          error.cause instanceof DatabaseClaimRefused
            ? new RunLedgerRefused({
                reason: 'not-owner',
                runId: run,
                detail: `held by ${error.cause.ownerId} (${error.cause.verdict})`,
              })
            : error,
        ),
      );
    });

    const load = Effect.fn('RunLedger.load')(function* (run: RunId) {
      const rows = yield* log.readAggregate(qualifyAggregateId('run', run), 1);
      const folded = foldRunState(null, rows);
      if (Result.isFailure(folded)) {
        return yield* new RunLedgerRefused({
          reason: 'inconsistent',
          runId: run,
          detail: folded.failure.detail,
          cause: folded.failure,
        });
      }
      const state = folded.success;
      if (state === null) return null;
      if (state.phase === null) {
        const cause = new RunLedgerInconsistent({
          reason: 'out-of-order',
          detail: 'ledger rows without an opening flow.snapshot',
          commit: state.commit,
        });
        return yield* new RunLedgerRefused({
          reason: 'inconsistent',
          runId: run,
          detail: cause.detail,
          cause,
        });
      }
      if (state.messages.length > 0) {
        const refusal = unprepared(run, state.messages);
        if (refusal !== null) return yield* refusal;
      }
      return state;
    });

    const appendBatch = Effect.fn('RunLedger.appendBatch')(function* (
      run: RunId,
      state: RunState | null,
      rows: readonly RunLedgerDraft[],
    ) {
      const violation = contractViolation(run, state, rows);
      if (violation !== null) {
        return yield* Effect.die(
          new Error(`RunLedger.appendBatch contract: ${violation}`),
        );
      }
      for (const row of rows) {
        for (const origin of rowOrigins(row)) {
          const endpoint = unsafeEndpoint(origin);
          if (endpoint !== null) {
            return yield* new RunLedgerRefused({
              reason: 'unsafe-endpoint',
              runId: run,
              detail: `endpoint ${endpoint} is not a scheme, host and path alone`,
            });
          }
        }
        if (row.type === 'model.compaction') {
          // A compaction is the first message-bearing row of its batch, so the
          // pre-batch history is the base `keepPrefix` indexes into. An empty
          // result goes unchecked, exactly as `load` leaves one unchecked.
          const kept = state === null ? [] : state.messages;
          const history = [
            ...kept.slice(0, row.payload.keepPrefix),
            ...row.payload.messages,
          ];
          if (history.length > 0) {
            const refusal = unprepared(run, history);
            if (refusal !== null) return yield* refusal;
          }
        }
      }
      const drafts: readonly SessionEventDraft[] = rows;
      const committed = yield* events.publish(drafts);
      const folded = foldRunState(state, committed);
      if (Result.isFailure(folded)) {
        return yield* new RunLedgerRefused({
          reason: 'inconsistent',
          runId: run,
          detail: folded.failure.detail,
          cause: folded.failure,
        });
      }
      if (folded.success === null) {
        return yield* Effect.die(
          new Error(
            'RunLedger.appendBatch contract: a batch on a fresh run appends a ledger row',
          ),
        );
      }
      return folded.success;
    });

    return { acquire, load, appendBatch };
  }),
);
