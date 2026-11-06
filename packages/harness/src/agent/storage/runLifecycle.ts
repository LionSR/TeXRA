/** A run's registration, a resume's activation, a stop and a run's end:
 *  the transactions that commit the lifecycle rows (built beside their
 *  readers in `shared/session/runFacts.ts`; record accessors:
 *  `runRecords.ts`). */

import { Context, Effect, Result, Schema, type Scope } from 'effect';
import stableStringify from 'safe-stable-stringify';

import type { RunRecord } from '@agent/core/definition/RunRecord';
import { Inbox } from '@agent/followUp/Inbox';
import type { TransactionPart } from '@agent/runtime/childTurnResult';
import { consumedRows } from '@agent/runtime/loop/rows';
import { SessionRoots } from '@platform/rootedFs';
import {
  RUN_OUTCOME,
  RunRecordFieldsSchema,
  qualifyAggregateId,
  type SessionEventDraft,
  type RunEnd,
  type RunEndOutput,
  type RunId,
  type RunOutcome,
  type RunStopReason,
} from '@shared/schemas';
import {
  Approvals,
  RunHistory,
  runReadRefusal,
  SessionLog,
} from '@shared/session/runHistory';
import {
  activationDrafts,
  type RegisterRunOptions,
  type Registration,
  registrationDrafts,
  runEndDraft,
} from '@shared/session/runFacts';
import type {
  RunHistoryDraft,
  RunInputDraft,
  RunState,
} from '@shared/session/runState';
import type { SessionTransaction } from '@shared/session/sessionLog';
import { ensureError } from '@utils/errors/errorMessage';
import { getRunRecords } from './runRecords';

function pinRunWorkingDirectory(record: RunRecord, root?: string): RunRecord {
  // First non-blank wins, untrimmed: a trimmed path was once mangled.
  const workingDirectory = [record.workingDirectory, root].find((dir) =>
    dir?.trim(),
  );
  return workingDirectory ? { ...record, workingDirectory } : record;
}

/** A defect is the path's failure, as a refusal is: its caller words it. */
const defectAsFailure = Effect.catchDefect((d) => Effect.fail(ensureError(d)));

/** What opening a run's rows reads of its session. */
type OpenServices = SessionLog | SessionRoots | Approvals;

/** A resume's activation: its `run.activate`, the grants it ends, and a
 *  `run.config` if its configuration changed (its model kept: only a
 *  switch moves it). Read in the activation's transaction. */
export const activationRows = Effect.fn('activationRows')(function* (
  runId: RunId,
  config: RunRecord,
): Effect.fn.Return<readonly SessionEventDraft[], Error, OpenServices> {
  const stored = yield* getRunRecords(runId).readRunRecord();
  const next = yield* Schema.decodeUnknownEffect(RunRecordFieldsSchema)(
    pinRunWorkingDirectory(
      stored?.model === undefined ? config : { ...config, model: stored.model },
      (yield* SessionRoots).workspace,
    ),
  );
  const changed =
    stored === null || stableStringify(stored) !== stableStringify(next);
  return activationDrafts(
    runId,
    yield* (yield* Approvals).activationRows(runId),
    changed ? next : null,
  );
});

/** Register a run whose loop is not this process's (an agent CLI, bash)
 *  alone; a run this process's loop drives registers with its opening. */
export const registerRun = Effect.fn('registerRun')(function* (
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<void, Error, OpenServices | RunHistory> {
  return yield* Effect.gen(function* () {
    const opens = yield* registrationRows(runId, record, options);
    const rows = Effect.succeed(opens.rows);
    const born = opens.start !== null;
    const cell = yield* (yield* RunHistory).open(
      runId,
      born ? { registration: rows } : { activation: () => rows },
    );
    if (born) yield* cell.append([]);
  }).pipe(defectAsFailure); // one that died wrote nothing: launch refused
});

/** The rows that register a run, uncommitted (with a `start`, they give
 *  birth to it, `run.start` first), which a caller commits with the run's
 *  first history in one batch, so no crash leaves it registered without
 *  that history. A child is refused under a parent that was stopped. */
export const registrationRows = Effect.fn('registrationRows')(function* (
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<Registration, Error, OpenServices> {
  return yield* Effect.gen(function* () {
    const prior = yield* getRunRecords(runId).exists();
    if (options.parentRunId !== undefined) {
      // A barrier first (a queued `run.start` reads absent); the database
      // refuses a closed or unborn parent, this only words the refusal.
      const log = yield* SessionLog;
      yield* log.transact([]);
      const parent = yield* log.facts(options.parentRunId);
      if (parent === null)
        return yield* Effect.fail(
          new Error(`Parent run ${options.parentRunId} is unavailable.`),
        );
      if (parent.stop !== null || parent.end !== null)
        return yield* Effect.fail(
          new Error(
            `Cannot launch child run ${runId} under run ${options.parentRunId}: that run was stopped.`,
          ),
        );
    }
    const config = yield* Schema.decodeUnknownEffect(RunRecordFieldsSchema)(
      pinRunWorkingDirectory(record, (yield* SessionRoots).workspace),
    );
    const ended = prior ? yield* (yield* Approvals).activationRows(runId) : [];
    return registrationDrafts(runId, config, options, !prior, ended);
  }).pipe(defectAsFailure);
});

/** What ends a run: its outcome and the facts its `run.end` carries. */
export interface RunEnding {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  /** The classified error behind a FAILED outcome, when the run has one. */
  readonly error?: RunEnd['error'];
  /** What the run produced; absent (empty) for a stop's end or a child. */
  readonly output?: RunEndOutput;
}

/** The `run.end` the store holds once the transaction committed, and
 *  whether this call wrote it (an earlier end of the lifecycle stands). */
export interface EndedRun {
  readonly end: Omit<RunEnd, 'usage'> | null;
  readonly wrote: boolean;
}

/** What a run's end reads of its session. */
export type EndServices = SessionLog | Inbox | RunHistory;

/** The caller's {@link EndServices}, for the end's transaction job. Picked
 *  when asked: the inbox's module and this one import each other. */
const endServices = Effect.suspend(() =>
  Effect.map(
    Effect.context<EndServices>(),
    Context.pick(SessionLog, Inbox, RunHistory),
  ),
);

const endOf = (end: Omit<RunEnd, 'usage'>): Omit<RunEnd, 'usage'> => ({
  outcome: end.outcome,
  ...(end.error !== undefined && { error: end.error }),
  output: end.output,
});

/** The cancellation of every request `state` leaves open: a run that ends
 *  answers them, so no surface keeps offering one nobody waits on. */
const cancelledRequests = (
  runId: RunId,
  state: RunState,
): readonly RunHistoryDraft[] =>
  Object.entries(state.requests).flatMap(([requestId, { decision }]) =>
    decision === null
      ? [
          {
            type: 'request.decided' as const,
            aggregateId: qualifyAggregateId('run', runId),
            requestId,
            decision: { action: 'cancel' as const, cause: 'The run ended.' },
          },
        ]
      : [],
  );

/**
 * A run's end in `tx`'s job, decided from what it reads under the lock:
 * the requests it leaves open cancelled, its unread input dropped, its
 * closure, its `run.end`, and a child's last turn beside it (`lastTurn`).
 * `leading` rows commit ahead of them (a stop's `run.stop`). A run never
 * created has nothing to end; one that ended in its current lifecycle
 * keeps that end. A run whose rows this build cannot load ends unloaded,
 * with a warning, requests uncancelled.
 */
export const endIn = Effect.fn('endIn')(function* (
  tx: Pick<SessionTransaction, 'append'>,
  input: RunEnding,
  lastTurn?: TransactionPart,
  leading: readonly RunInputDraft[] = [],
): Effect.fn.Return<EndedRun, Error, EndServices | Scope.Scope> {
  const { append } = tx;
  const { runId, outcome, error } = input;
  const log = yield* SessionLog;
  const facts = yield* log.facts(runId);
  if (facts === null) return { end: null, wrote: false };
  if (facts.end !== null) {
    if (error !== undefined)
      yield* Effect.logWarning(`Run ${runId} had ended: ${error.message}`);
    if (leading.length > 0) yield* append(leading);
    return { end: endOf(facts.end), wrote: false };
  }
  const last: Effect.Success<TransactionPart> = yield* (
    lastTurn ?? Effect.succeed({ rows: [] })
  );
  const end = runEndDraft(runId, {
    outcome,
    error,
    note: last.note,
    output: input.output,
  });
  const unapplied = (yield* (yield* Inbox).read(runId)).followUps;
  const beside = [
    ...leading,
    ...consumedRows(runId)(unapplied, { kind: 'dropped', reason: 'ended' }),
    ...log.closure(runId, outcome),
    end,
    ...last.rows,
  ];
  const cell = yield* Effect.result(
    (yield* RunHistory).open(runId, { within: append }),
  );
  if (Result.isSuccess(cell)) {
    const cancels = cancelledRequests(runId, yield* cell.success.current);
    yield* cell.success.append(cancels, Effect.succeed(beside));
  } else {
    if (runReadRefusal(cell.failure) === undefined) return yield* cell.failure;
    yield* Effect.logWarning(
      `Run ${runId} ends unloaded: ${cell.failure.message}`,
    );
    yield* append(beside);
  }
  return { end: endOf(end), wrote: true };
});

/**
 * The one transaction of a run's end ({@link endIn}), run by the fiber
 * that drove the run as it exits, or by a stop for a run no fiber drives.
 * A failed transaction fails the caller: the run then reads as interrupted
 * at its next open, which is the truth, since the process could not write
 * its end.
 */
export const endRunRows = Effect.fn('endRunRows')(function* (
  input: RunEnding,
  lastTurn?: TransactionPart,
  leading: readonly RunInputDraft[] = [],
): Effect.fn.Return<EndedRun, Error, EndServices> {
  const log = yield* SessionLog;
  const services = yield* endServices;
  return yield* log.transact((tx) =>
    endIn(tx, input, lastTurn, leading).pipe(
      Effect.scoped,
      Effect.provide(services),
    ),
  );
});

/**
 * The rows a stop commits for `runId`: its `run.stop` row, and, for a run
 * no fiber here drives (`end`), its CANCELLED end in the same batch. A run
 * with no rows, or whose lifecycle ended, gets none: there is nothing to
 * stop.
 */
export const stopRun = Effect.fn('stopRun')(function* (
  runId: RunId,
  reason: RunStopReason,
  end: boolean,
): Effect.fn.Return<void, Error, EndServices> {
  const log = yield* SessionLog;
  const services = yield* endServices;
  yield* log.transact((tx) =>
    Effect.gen(function* () {
      const facts = yield* log.facts(runId);
      if (facts === null || facts.end !== null) return;
      const stop = {
        type: 'run.stop',
        aggregateId: qualifyAggregateId('run', runId),
        reason,
      } as const;
      if (!end) {
        yield* tx.append([stop]);
        return;
      }
      yield* endIn(tx, { runId, outcome: RUN_OUTCOME.CANCELLED }, undefined, [
        stop,
      ]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
