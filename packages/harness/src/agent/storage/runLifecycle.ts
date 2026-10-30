/** A run's registration, a resume's activation and a run's end: the
 *  transactions that commit the lifecycle rows (built beside their readers
 *  in `shared/session/runFacts.ts`; record accessors: `runRecords.ts`). */

import { Cause, Effect, Exit, Result, Schema, type Scope } from 'effect';
import stableStringify from 'safe-stable-stringify';

import type { RunRecord } from '@agent/core/definition/RunRecord';
import type { TransactionPart } from '@agent/runtime/childTurnResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { consumedRows, haltedPositionRow } from '@agent/runtime/loop/rows';
import {
  RUN_OUTCOME,
  RunRecordFieldsSchema,
  qualifyAggregateId,
  type SessionEventDraft,
  type RunEnd,
  type RunEndOutput,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import type { Append } from '@shared/session/sessionEvents';
import { unloadable } from '@shared/session/runHistory';
import {
  activationDrafts,
  lastLifecycleRow,
  type RegisterRunOptions,
  registrationDrafts,
  runEndDraft,
  runEndFromEvents,
} from '@shared/session/runFacts';
import type { RunHistoryDraft, RunInputDraft } from '@shared/session/runState';
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

/** The stop ending the run is the session's own clean close: its halt says so. */
const closedBySession = (session: SessionHandle, input: Ending): boolean =>
  input.stopped === true &&
  session.runs.get(input.runId)?.stopReason === 'shutdown';

/** A resume's activation: its `run.activate`, the grants it ends, and a
 *  `run.config` if its configuration changed (its model kept: only a
 *  switch moves it). Read in the activation's transaction, under its claim. */
export const activationRows = Effect.fn('activationRows')(function* (
  session: SessionHandle,
  runId: RunId,
  config: RunRecord,
): Effect.fn.Return<readonly SessionEventDraft[], Error> {
  const stored = yield* getRunRecords(session, runId).readRunRecord();
  const next = yield* Schema.decodeUnknownEffect(RunRecordFieldsSchema)(
    pinRunWorkingDirectory(
      stored?.model === undefined ? config : { ...config, model: stored.model },
      session.roots.workspace,
    ),
  );
  const changed =
    stored === null || stableStringify(stored) !== stableStringify(next);
  return activationDrafts(
    runId,
    yield* session.approvals.activationRows(runId),
    changed ? next : null,
  );
});

/** Register a run whose loop is not this process's (an agent CLI, bash)
 *  alone; a run this process's loop drives registers with its opening. */
export const registerRun = Effect.fn('registerRun')(function* (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<void, Error> {
  return yield* Effect.gen(function* () {
    const opens = yield* registrationRows(session, runId, record, options);
    const rows = Effect.succeed(opens.rows);
    const cell = yield* session.runHistory.open(
      runId,
      opens.born ? { registration: rows } : { activation: () => rows },
    );
    if (opens.born) yield* cell.append([]);
  }).pipe(defectAsFailure); // one that died wrote nothing: launch refused
});

/** The rows that register a run, uncommitted (`born`: they open it, with
 *  `run.start` first), which a caller commits with the run's first history
 *  in one batch, so no crash leaves it registered without that history. */
export const registrationRows = Effect.fn('registrationRows')(function* (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<
  { readonly born: boolean; readonly rows: readonly SessionEventDraft[] },
  Error
> {
  return yield* Effect.gen(function* () {
    // A re-registration takes the existing run's claim over as it commits.
    const prior = yield* getRunRecords(session, runId).exists();
    if (options.parentRunId !== undefined) {
      // A barrier first (a queued `run.start` reads absent); the database
      // refuses a closed or unborn parent, this only words the refusal.
      yield* session.log.transact([]);
      if (!(yield* getRunRecords(session, options.parentRunId).exists()))
        return yield* Effect.fail(
          new Error(`Parent run ${options.parentRunId} is unavailable.`),
        );
    }
    // Its configuration rides the batch that takes the claim, never
    // compared before it is held (a takeover skips nothing on a stale read).
    const config = yield* Schema.decodeUnknownEffect(RunRecordFieldsSchema)(
      pinRunWorkingDirectory(record, session.roots.workspace),
    );
    const ended = prior ? yield* session.approvals.activationRows(runId) : [];
    return {
      born: !prior,
      rows: registrationDrafts(runId, config, options, !prior, ended),
    };
  }).pipe(defectAsFailure);
});

/** What ends a run: its outcome and the facts its `run.end` carries. */
export interface FinalizeRunInput {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  /** An end no driver here writes (a stop that reached no live target, a
   *  failed hand-off, a backstop), under a claim it takes itself. */
  readonly ownerless?: boolean;
  /** A stop ended the run: a trace row the store refused does not fail it. */
  readonly stopped?: boolean;
  /** The classified error behind a FAILED outcome, when the run has one. */
  readonly error?: RunEnd['error'];
  /** What the run produced; absent (empty) for a backstop or a child. */
  readonly output?: RunEndOutput;
  /** A child's last turn result under the outcome its end resolves,
   *  committed with that end (or, if refused, the notice that it was lost). */
  readonly lastTurn?: (
    outcome: RunOutcome,
  ) => Effect.Effect<TransactionPart | undefined>;
}

/** The `run.end` held (`wrote`: this call's); none if unborn or held back. */
export interface FinalizedRun {
  readonly end: Omit<RunEnd, 'usage'> | null;
  readonly wrote: boolean;
}

const endOf = ({ outcome, error, output }: Omit<RunEnd, 'usage'>) =>
  error ? { outcome, error, output } : { outcome, output };

type Ending = Omit<FinalizeRunInput, 'lastTurn'>;

/** A run's end in `append`'s job (halt, unread input, closure, `run.end`,
 *  last turn); an unloadable run's, all but the halt, with a warning. */
export const endIn = Effect.fn('endIn')(function* (
  session: SessionHandle,
  append: Append,
  input: Ending,
  last?: TransactionPart,
) {
  const { runId, outcome, error } = input;
  const facts = yield* session.log.facts(runId);
  // A run never created has nothing to end: its launch reports the failure.
  if (facts === null) return { end: null, wrote: false };
  const lastTurn: Effect.Success<TransactionPart> = yield* last ??
    Effect.succeed({ rows: [] });
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
      error,
      note: lastTurn.note,
      output: input.output,
    });
    written = endOf(end);
    const closed = closedBySession(session, input);
    halt =
      facts.position === null
        ? []
        : [haltedPositionRow(facts.position, persisted, closed)];
    const unapplied = (yield* session.followUps.read(runId)).followUps;
    closing = [
      ...consumedRows(runId)(unapplied, { kind: 'dropped', reason: 'ended' }),
      ...session.trace.closure(runId, persisted),
      end,
    ];
  }
  // What the store holds once this commits.
  const end = facts.end ? endOf(facts.end) : written;
  const result = { end, wrote: written !== null };
  const beside = [...closing, ...lastTurn.rows];
  const cell = yield* Effect.result(
    session.runHistory.open(runId, { within: append }),
  );
  if (Result.isSuccess(cell))
    return yield* Effect.as(
      cell.success.append(halt, Effect.succeed(beside)),
      result,
    );
  if (!unloadable(cell.failure)) return yield* cell.failure;
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
  session: SessionHandle,
  runId: RunId,
  cascade: boolean,
) {
  const facts = yield* session.log.facts(runId);
  if (cascade && facts !== null) yield* session.log.hold(runId, { ends: true });
  for (const child of yield* openOwnedChildren(session, runId)) {
    if (!cascade || session.runs.get(child.runId) !== undefined)
      return yield* Effect.fail(
        new Error(
          `Run ${runId} cannot end while its open call ${child.callId} owns run ${child.runId}, which has not ended`,
        ),
      );
    // Retired CANCELLED (an outcome it wrote stands).
    yield* finalizeRun(session, {
      runId: child.runId,
      outcome: RUN_OUTCOME.CANCELLED,
      ownerless: true,
      stopped: true,
    });
  }
  return facts?.end != null;
});

/** The one writer of a run's end ({@link endIn}, in its own transaction),
 *  driver's or not, answering the end the store holds. An end that does
 *  not commit fails it, after a FAILED backstop end it tries alone, loudly. */
export const finalizeRun = Effect.fn('finalizeRun')(function* (
  session: SessionHandle,
  input: FinalizeRunInput,
): Effect.fn.Return<FinalizedRun, Error, Scope.Scope> {
  const { runId, outcome, ownerless } = input;
  const end = (ending: Ending, lastTurn?: TransactionPart) =>
    Effect.exit(
      session.log.transact((tx) =>
        endIn(session, tx.append, ending, lastTurn).pipe(Effect.scoped),
      ),
    );
  const stood = yield* beforeEnd(session, runId, ownerless === true).pipe(
    defectAsFailure,
  );
  // Read once readied (a refusal leaves them unread): rows the store refused
  // fail the run unless a stop ended it, whoever ends it.
  const lost = yield* session.trace.lost(runId);
  const failed = lost !== undefined && input.stopped !== true;
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
      ? yield* Effect.result(session.log.rows(qualifyAggregateId('run', runId)))
      : undefined;
  if (read?._tag === 'Success' && Exit.isFailure(status)) {
    const cause = ensureError(Cause.squash(status.cause)).message;
    yield* Effect.logWarning(
      `Run ${runId}: its end with its last turn: ${cause}`,
    );
    const landed = runEndFromEvents(read.success, runId);
    if (landed !== null) return { end: endOf(landed), wrote: !stood };
    // The parent's notice rides this end's append (both commit or neither),
    // one per lifecycle (its `run.activate`) so a later loss is no replay;
    // a parent that refuses it is the end's note, on the card.
    const since = lastLifecycleRow(read.success, runId);
    const deliveryId = lostResultId(runId, since?.commit);
    const text = `The result of run ${runId} was lost: ${cause}`;
    const notice = Effect.gen(function* () {
      const to = yield* persistedParentRunId(session, runId);
      if (to === undefined) return { rows: [] };
      const from = { kind: 'run', runId } as const;
      const { rows, sent } = yield* session.followUps
        .admission(to, { text, from, deliveryId }, {})
        .pipe(Effect.catch((e) => Effect.succeed({ rows: [], sent: e })));
      if ('kind' in sent && sent.kind !== 'refused') return { rows };
      const note = `parent not told (${'kind' in sent ? sent.reason : sent.message})`;
      yield* session.log.afterCommit(Effect.logWarning(`${runId}: ${note}`));
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
