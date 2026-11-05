/** A run's registration, a resume's activation and a run's end: the
 *  transactions that commit the lifecycle rows (built beside their readers
 *  in `shared/session/runFacts.ts`; record accessors: `runRecords.ts`). */

import {
  Cause,
  Context,
  Effect,
  Exit,
  Result,
  Schema,
  type Scope,
  Struct,
} from 'effect';
import stableStringify from 'safe-stable-stringify';

import type { RunRecord } from '@agent/core/definition/RunRecord';
import { Inbox } from '@agent/followUp/ToolUseFollowUp';
import type { TransactionPart } from '@agent/runtime/childTurnResult';
import { consumedRows, haltedPositionRow } from '@agent/runtime/loop/rows';
import { Runs } from '@agent/runtime/runRegistry';
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
  type SessionViewAccess,
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
import {
  getRunRecords,
  lostResultId,
  openOwnedChildren,
  persistedParentRunId,
} from './runRecords';

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
 *  switch moves it). Read in the activation's transaction, under its claim. */
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
 *  that history. */
export const registrationRows = Effect.fn('registrationRows')(function* (
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<Registration, Error, OpenServices> {
  return yield* Effect.gen(function* () {
    // A re-registration takes the existing run's claim over as it commits.
    const prior = yield* getRunRecords(runId).exists();
    if (options.parentRunId !== undefined) {
      // A barrier first (a queued `run.start` reads absent); the database
      // refuses a closed or unborn parent, this only words the refusal.
      yield* (yield* SessionLog).transact([]);
      if (!(yield* getRunRecords(options.parentRunId).exists()))
        return yield* Effect.fail(
          new Error(`Parent run ${options.parentRunId} is unavailable.`),
        );
    }
    // Its configuration rides the batch that takes the claim, never
    // compared before it is held (a takeover skips nothing on a stale read).
    const config = yield* Schema.decodeUnknownEffect(RunRecordFieldsSchema)(
      pinRunWorkingDirectory(record, (yield* SessionRoots).workspace),
    );
    const ended = prior ? yield* (yield* Approvals).activationRows(runId) : [];
    return registrationDrafts(runId, config, options, !prior, ended);
  }).pipe(defectAsFailure);
});

/** What ends a run: its outcome and the facts its `run.end` carries; `R`,
 *  what building its last turn reads of the caller beside its session. */
export interface FinalizeRunInput<R = never> {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  /** An end no driver here writes (a stop that reached no live target, a
   *  failed hand-off, a backstop), under a claim it takes itself. */
  readonly ownerless?: boolean;
  /** Why the run stopped, when a person's stop or a shutdown did (a release
   *  names none): recorded on a cancelled end. */
  readonly reason?: RunStopReason;
  /** The classified error behind a FAILED outcome, when the run has one. */
  readonly error?: RunEnd['error'];
  /** What the run produced; absent (empty) for a backstop or a child. */
  readonly output?: RunEndOutput;
  /** A child's last turn result under the outcome its end resolves,
   *  committed with that end (or, if refused, the notice that it was lost). */
  readonly lastTurn?: (
    outcome: RunOutcome,
  ) => Effect.Effect<TransactionPart | undefined, never, EndServices | R>;
}

/** The `run.end` held (`wrote`: this call's); none if unborn or held back. */
interface FinalizedRun {
  readonly end: Omit<RunEnd, 'usage'> | null;
  readonly wrote: boolean;
}

const endOf = <E extends Omit<RunEnd, 'usage'>>(end: E) =>
  Struct.pick(end, ['outcome', 'reason', 'error', 'output']);

type Ending = Omit<FinalizeRunInput, 'lastTurn'>;

/** What a run's end reads of its session. */
export type EndServices = SessionLog | Inbox | Runs | RunHistory;

/** The caller's {@link EndServices} for the publisher job an end runs in. */
export const endServices = Effect.map(
  Effect.context<EndServices>(),
  Context.pick(SessionLog, Inbox, Runs, RunHistory),
);

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

/** A run's end in `tx`'s job (the requests it leaves open, its halt, unread
 *  input, closure, `run.end`, last turn); an unloadable run's, all but the
 *  halt, with a warning. A last turn held for a parent another process has
 *  open lets the run's claim go with it; its deliverer ends it claim-free. */
export const endIn = Effect.fn('endIn')(function* (
  tx: Pick<SessionTransaction, 'append' | 'release'>,
  input: Ending,
  last?: TransactionPart,
) {
  const { append } = tx;
  const { runId, outcome, error } = input;
  const log = yield* SessionLog;
  const facts = yield* log.facts(runId);
  // A run never created has nothing to end: its launch reports the failure.
  if (facts === null) return { end: null, wrote: false };
  const lastTurn: Effect.Success<TransactionPart> = yield* (
    last ?? Effect.succeed({ rows: [] })
  );
  // Ended in its current lifecycle, that end stands: a resumed run ends
  // again, or every `durableOutcome` reader keeps it RUNNING for want of
  // the row.
  const ended = facts.end?.outcome;
  const persisted = ended ?? outcome;
  if (ended !== undefined && error !== undefined)
    yield* Effect.logWarning(`Run ${runId} had ended: ${error.message}`);
  // No end while it had ended or holds a result for delivery; else the
  // loop's halt, never apart from its end, and the end's rows.
  let written: Omit<RunEnd, 'usage'> | null = null;
  let halt: readonly RunHistoryDraft[] = [];
  let closing: readonly RunInputDraft[] = [];
  if (ended === undefined && lastTurn.held !== true) {
    const end = runEndDraft(runId, {
      outcome: persisted,
      reason: input.reason,
      error,
      note: lastTurn.note,
      output: input.output,
    });
    written = endOf(end);
    halt =
      facts.position === null
        ? []
        : [haltedPositionRow(facts.position, persisted)];
    const unapplied = (yield* (yield* Inbox).read(runId)).followUps;
    closing = [
      ...consumedRows(runId)(unapplied, { kind: 'dropped', reason: 'ended' }),
      ...log.closure(runId, persisted),
      end,
    ];
  }
  // What the store holds once this commits.
  const end = facts.end ? endOf(facts.end) : written;
  const result = { end, wrote: written !== null };
  const beside = [...closing, ...lastTurn.rows];
  const cell = yield* Effect.result(
    (yield* RunHistory).open(runId, { within: append }),
  );
  if (Result.isSuccess(cell)) {
    const cancels =
      written === null
        ? []
        : cancelledRequests(runId, yield* cell.success.current);
    yield* cell.success.append([...cancels, ...halt], Effect.succeed(beside));
    if (lastTurn.held === true) yield* tx.release(runId);
    return result;
  }
  if (runReadRefusal(cell.failure) === undefined) return yield* cell.failure;
  yield* Effect.logWarning(
    `Run ${runId} ends unloaded: ${cell.failure.message}`,
  );
  yield* append(beside);
  return result;
});

/** Ready a run's end, answering whether one stood: an ownerless end
 *  (`cascade`) claims a born run and retires the children its open calls
 *  own; a driver's own end, or a stop whose child is live, is refused. */
const beforeEnd = Effect.fn('beforeEnd')(function* (
  runId: RunId,
  cascade: boolean,
) {
  const log = yield* SessionLog;
  const runs = yield* Runs;
  const facts = yield* log.facts(runId);
  if (cascade && facts !== null) yield* log.hold(runId, { ends: true });
  for (const child of yield* openOwnedChildren(runId)) {
    if (!cascade || runs.get(child.runId) !== undefined)
      return yield* Effect.fail(
        new Error(
          `Run ${runId} cannot end while its open call ${child.callId} owns run ${child.runId}, which has not ended`,
        ),
      );
    // Retired CANCELLED (an outcome it wrote stands).
    yield* finalizeRun({
      runId: child.runId,
      outcome: RUN_OUTCOME.CANCELLED,
      ownerless: true,
    });
  }
  return facts?.end != null;
});

/** The one writer of a run's end ({@link endIn}, in its own transaction),
 *  driver's or not, answering the end the store holds. An end that does
 *  not commit fails it, after a FAILED backstop end it tries alone, loudly. */
export const finalizeRun = Effect.fn('finalizeRun')(function* <R = never>(
  input: FinalizeRunInput<R>,
): Effect.fn.Return<
  FinalizedRun,
  Error,
  R | Scope.Scope | EndServices | SessionViewAccess | SessionRoots
> {
  const { runId, outcome, ownerless } = input;
  const services = yield* endServices;
  const log = Context.get(services, SessionLog);
  const end = (ending: Ending, lastTurn?: TransactionPart) =>
    Effect.exit(
      log.transact((tx) =>
        endIn(tx, ending, lastTurn).pipe(
          Effect.scoped,
          Effect.provide(services),
        ),
      ),
    );
  const stood = yield* defectAsFailure(beforeEnd(runId, ownerless === true));
  // Read once readied (a refusal leaves them unread): rows the store refused
  // fail the run unless a stop ended it (CANCELLED), whoever ends it.
  const lost = yield* log.lost(runId);
  const failed = lost !== undefined && outcome !== RUN_OUTCOME.CANCELLED;
  const requested = {
    ...input,
    outcome: failed ? RUN_OUTCOME.FAILED : outcome,
    error: lost ?? input.error,
  };
  const lastTurn = input.lastTurn && (yield* input.lastTurn(requested.outcome));
  let status = yield* end(requested, lastTurn);
  // A refused last turn: a committed end is this call's unless one `stood`;
  // with none, the end records the loss (a failed read: the backstop's).
  const read =
    Exit.isFailure(status) && lastTurn !== undefined
      ? yield* Effect.result(
          log.runRows(qualifyAggregateId('run', runId), 'lifecycle'),
        )
      : undefined;
  if (read?._tag === 'Success' && Exit.isFailure(status)) {
    const cause = ensureError(Cause.squash(status.cause)).message;
    yield* Effect.logWarning(
      `Run ${runId}: its end with its last turn: ${cause}`,
    );
    const landed = read.success.end;
    if (landed !== null) return { end: endOf(landed), wrote: !stood };
    // The parent's notice rides this end's append (both commit or neither),
    // one per lifecycle (its `run.activate`) so a later loss is no replay;
    // a parent that refuses it is the end's note, on the card.
    const since = read.success.activation;
    const deliveryId = lostResultId(runId, since?.commit);
    const text = `The result of run ${runId} was lost: ${cause}`;
    const notice = Effect.gen(function* () {
      const to = yield* persistedParentRunId(runId);
      if (to === undefined) return { rows: [] };
      const from = { kind: 'run', runId } as const;
      const { rows, sent } = yield* (yield* Inbox)
        .admission(to, { text, from, deliveryId }, {})
        .pipe(Effect.catch((e) => Effect.succeed({ rows: [], sent: e })));
      if ('kind' in sent && sent.kind !== 'refused') return { rows };
      const note = `parent not told (${'kind' in sent ? sent.reason : sent.message})`;
      yield* log.afterCommit(Effect.logWarning(`${runId}: ${note}`));
      return { rows, note };
    });
    const had = [cause, requested.error?.message].filter(Boolean);
    const message = `Result lost: ${had.join('; it ended: ')}`;
    const error = { kind: 'result-lost', message } as const;
    status = yield* end({ ...requested, error }, notice);
  }
  if (Exit.isSuccess(status)) return status.value;
  // The last backstop, loud: the end alone, FAILED.
  const error = ensureError(Cause.squash(status.cause));
  const message = `The run's end was not saved: ${error.message}`;
  yield* Effect.logWarning(`Run ${runId}: ${message}`);
  const backstop = yield* end({
    runId,
    outcome: RUN_OUTCOME.FAILED,
    error: { kind: 'unexpected', message },
  });
  if (Exit.isFailure(backstop))
    yield* Effect.logError(`Run ${runId} reads as running: no end commits`);
  return yield* Effect.fail(error);
}, Effect.scoped);
