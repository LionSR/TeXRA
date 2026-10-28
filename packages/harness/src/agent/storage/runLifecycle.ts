/** A run's registration, a resume's activation and a run's end: the rows
 *  its cell commits (record accessors: `runRecords.ts`). */

import { Cause, Effect, Exit, Result, Schema } from 'effect';
import stableStringify from 'safe-stable-stringify';

import type { RunRecord } from '@agent/core/definition/RunRecord';
import type { TransactionPart } from '@agent/runtime/childTurnResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { consumedRows, haltedPositionRow } from '@agent/runtime/loop/rows';
import {
  NO_APPROVAL_GRANTS,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';

import {
  RUN_OUTCOME,
  RunRecordFieldsSchema,
  qualifyAggregateId,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
  emptyRunEndOutput,
  type RunEnd,
  type RunEndOutput,
  type RunId,
  type RunIdentity,
  type RunOutcome,
  type RunParent,
  type RunProvenance,
  type UserFollowUpSupport,
} from '@shared/schemas';
import type { Append } from '@shared/session/sessionEvents';
import { unloadable } from '@shared/session/runHistory';
import { lastLifecycleRow, runEndFromEvents } from '@shared/session/runFacts';
import type { RunHistoryDraft, RunInputDraft } from '@shared/session/runState';
import { ensureError } from '@utils/errors/errorMessage';
import {
  getRunRecords,
  lostResultId,
  openOwnedChildren,
  persistedParentRunId,
} from './runRecords';

function pinRunWorkingDirectory(
  record: RunRecord,
  workspaceRoot: string | undefined,
): RunRecord {
  // First non-blank wins, untrimmed: trimming mangled paths (2e3197f92f).
  const workingDirectory = [record.workingDirectory, workspaceRoot].find(
    (dir) => dir?.trim(),
  );
  return workingDirectory ? { ...record, workingDirectory } : record;
}

/** A defect is the path's failure, as a refusal is: its caller words it. */
const defectAsFailure = Effect.catchDefect((defect) =>
  Effect.fail(ensureError(defect)),
);

/** A resume's activation: its `run.activate`, the grants it ends, and a
 *  `run.config` if its configuration changed (its model kept: only a
 *  switch moves it). Read in the activation's transaction, under its claim. */
export const activationRows = Effect.fn('activationRows')(function* (
  session: SessionHandle,
  runId: RunId,
  config: RunRecord,
): Effect.fn.Return<readonly SessionEventDraft[], Error> {
  const target = qualifyAggregateId('run', runId);
  const stored = yield* getRunRecords(session, runId).readRunRecord();
  const next = yield* Schema.decodeUnknownEffect(RunRecordFieldsSchema)(
    pinRunWorkingDirectory(
      stored?.model === undefined ? config : { ...config, model: stored.model },
      session.roots.workspace,
    ),
  );
  const changed =
    stored === null || stableStringify(stored) !== stableStringify(next);
  return [
    { type: 'run.activate', aggregateId: target },
    ...(yield* session.approvals.activationRows(runId)),
    ...(changed
      ? [{ type: 'run.config' as const, aggregateId: target, config: next }]
      : []),
  ];
});

/** What a run is registered with: the facts its `run.start` carries. */
export interface RegisterRunOptions {
  /** The launching run: the whole parent edge, stamped on `run.start`. */
  readonly parentRunId?: RunId;
  /** The parent's call that launched it, which owns this run until it
   *  detaches, and that call's tool card. */
  readonly parentCall?: NonNullable<RunParent['call']>;
  /** The run's identity, declared by the launch site — the durable authority. */
  readonly identity: RunIdentity;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  readonly userFollowUpSupport?: UserFollowUpSupport;
  /** The run's `run.description`, durable at birth: a child's
   *  task label; a root's summary comes later as a second row. */
  readonly description?: string;
  /** Who wrote it: the model, unless a fork copies its user's title. */
  readonly descriptionBy?: 'model' | 'user';
  readonly provenance?: RunProvenance; // a fork's source and cut
  readonly grants?: ApprovalGrants; // the grants it starts with
  /** A fork's history, which its opening commits in place of a prompt
   *  (`forkSeed`): the run is born on it, not resumed onto it. */
  readonly seed?: readonly RunHistoryDraft[];
}

/** Register a run whose loop is not this process's (an agent CLI, bash)
 *  alone; a run this process's loop drives registers with its opening. */
export const registerRun = Effect.fn('registerRun')(function* (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<void, Error> {
  return yield* Effect.gen(function* () {
    const rows = yield* registrationRows(session, runId, record, options);
    const born = rows[0]?.type === 'run.start';
    const cell = yield* session.runHistory.open(
      runId,
      born
        ? { registration: Effect.succeed(rows) }
        : { activation: () => Effect.succeed(rows) },
    );
    if (born) yield* cell.append([]);
  }).pipe(defectAsFailure); // one that died wrote nothing: launch refused
});

/** The rows that register a run, uncommitted (`run.start` first for a
 *  birth), which a caller commits with the run's first history in one
 *  batch, so no crash leaves it registered without that history. */
export const registrationRows = Effect.fn('registrationRows')(function* (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<readonly SessionEventDraft[], Error> {
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
    const pinned = pinRunWorkingDirectory(record, session.roots.workspace);
    const target = qualifyAggregateId('run', runId);
    // Its configuration rides the batch that takes the claim, never
    // compared before it is held (a takeover skips nothing on a stale read).
    const config = {
      type: 'run.config',
      aggregateId: target,
      config: yield* Schema.decodeUnknownEffect(RunRecordFieldsSchema)(pinned),
    } satisfies SessionEventDraft;
    const events: SessionEventDraft[] = [];
    if (!prior) {
      const worktreeCwd = pinned.workingDirectory?.trim();
      events.push({
        type: 'run.start',
        aggregateId: target,
        identity: options.identity,
        userFollowUpSupport:
          options.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
        worktree: worktreeCwd ? { workingDirectory: worktreeCwd } : undefined,
        parent:
          options.parentRunId === undefined
            ? null
            : {
                id: options.parentRunId,
                call: options.parentCall ?? null,
              },
        provenance: options.provenance ?? null,
        approvalPolicy: options.grants ?? NO_APPROVAL_GRANTS,
      });
    }
    events.push(config);
    events.push({ type: 'run.activate', aggregateId: target });
    if (prior) events.push(...(yield* session.approvals.activationRows(runId)));
    if (options.description !== undefined)
      events.push({
        type: 'run.description',
        aggregateId: target,
        description: options.description,
        by: options.descriptionBy ?? 'model',
      });
    return events;
  }).pipe(defectAsFailure);
});

export interface FinalizeRunInput {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  /** Keep an outcome already written: a backstop (the host-exit drain)
   *  owns no result. Read and write share one transaction. */
  readonly keepExistingOutcome?: boolean;
  /** The classified error behind a FAILED outcome, when the run has one. */
  readonly error?: RunEnd['error'];
  /** What the run produced; absent (an empty output) for a backstop, and
   *  for a child, whose product is its per-turn delivery. */
  readonly output?: RunEndOutput;
  /** A child's last turn result, committed with the run's end (or, once
   *  that result could not be saved, the notice to its parent that it was
   *  lost). */
  readonly lastTurn?: TransactionPart;
}

/** A run's end as it stands on disk: `recorded` is false for a run never
 *  born, whose launch reports its failure. */
export interface FinalizedRun {
  readonly recorded: boolean;
}

/** A run's end in `append`'s job (halt, unread input, closure, `run.end`,
 *  last turn); an unloadable run's, all but the halt, with a warning. */
export const endIn = Effect.fn('endIn')(function* (
  session: SessionHandle,
  append: Append,
  input: FinalizeRunInput,
) {
  const { runId, outcome, keepExistingOutcome, error } = input;
  const target = qualifyAggregateId('run', runId);
  const rows = yield* session.log.records(runId);
  // A run never created has nothing to end: its launch reports the failure.
  if (!rows.some((row) => row.type === 'run.start')) return { recorded: false };
  const lastTurn: Effect.Success<TransactionPart> = yield* input.lastTurn ??
    Effect.succeed({ rows: [] });
  // Ended in its current lifecycle: a resumed run ends again, even the same
  // way, or every `durableOutcome` reader keeps it RUNNING for want of the row.
  const ended = runEndFromEvents(rows, runId)?.outcome;
  const persisted =
    keepExistingOutcome === true && ended !== undefined ? ended : outcome;
  // No end now: the run already ended this way, or its end waits until the
  // result it holds is delivered.
  const skipEnd = ended === persisted || lastTurn.held === true;
  if (ended === persisted && error !== undefined)
    yield* Effect.logWarning(`Run ${runId} had ended: ${error.message}`);
  // The loop's halt, never apart from its end, through the run's cell.
  const halt = skipEnd
    ? []
    : rows.flatMap((row) =>
        row.type === 'run.position' ? [haltedPositionRow(row, persisted)] : [],
      );
  const closing: readonly RunInputDraft[] = skipEnd
    ? []
    : [
        ...consumedRows(
          runId,
          (yield* session.followUps.read(runId)).followUps,
        ),
        ...session.trace.closure(runId, persisted),
        {
          type: 'run.end' as const,
          aggregateId: target,
          outcome: persisted,
          ...(error && {
            error: {
              ...error,
              message: [error.message, lastTurn.note]
                .filter(Boolean)
                .join('; '),
            },
          }),
          output: input.output ?? emptyRunEndOutput(),
        },
      ];
  const result = { recorded: true };
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

/** No run ends while its open call owns a child that has not ended. A
 *  stop or backstop (`cascade`) retires such a child first; the run's own
 *  terminal, or a stop whose child is live here, is refused. */
const endOwnedChildren = Effect.fn('endOwnedChildren')(function* (
  session: SessionHandle,
  runId: RunId,
  cascade: boolean,
) {
  for (const child of yield* openOwnedChildren(session, runId)) {
    if (!cascade || session.runs.get(child.runId)?.live === true)
      return yield* Effect.fail(
        new Error(
          `Run ${runId} cannot end while its open call ${child.callId} owns run ${child.runId}, which has not ended`,
        ),
      );
    // Retired CANCELLED (an outcome it wrote stands), under its own claim.
    yield* Effect.scoped(
      Effect.andThen(
        session.log.hold(child.runId, { ends: true }),
        finalizeRun(session, {
          runId: child.runId,
          outcome: RUN_OUTCOME.CANCELLED,
          keepExistingOutcome: true,
        }),
      ),
    );
  }
});

/** The one writer of a run's end ({@link endIn}, in its own transaction),
 *  driver's or not. An end that does not commit fails it, after a FAILED
 *  backstop end it tries alone, loudly. */
export const finalizeRun = Effect.fn('finalizeRun')(function* (
  session: SessionHandle,
  input: FinalizeRunInput,
): Effect.fn.Return<FinalizedRun, Error> {
  const { runId, outcome, keepExistingOutcome } = input;
  yield* endOwnedChildren(session, runId, keepExistingOutcome === true).pipe(
    defectAsFailure,
  );
  const end = (ending: FinalizeRunInput) =>
    Effect.exit(
      session.log.transact((tx) =>
        endIn(session, tx.append, ending).pipe(Effect.scoped),
      ),
    );
  // Rows the run published and the store refused fail it, whoever ends it.
  const lost = yield* session.trace.lost(runId);
  const failed = lost !== undefined && outcome !== RUN_OUTCOME.CANCELLED;
  const { lastTurn, ...requested } = {
    ...input,
    outcome: failed ? RUN_OUTCOME.FAILED : outcome,
    error: input.error ?? lost,
  };
  let status = yield* end({ ...requested, lastTurn });
  // A refused last turn: the end keeps its outcome and records the loss,
  // once a read shows no end committed with it (its publication may have
  // failed after); a failed read leaves the end to the backstop, loudly.
  const read =
    Exit.isFailure(status) && lastTurn !== undefined
      ? yield* Effect.result(session.log.records(runId))
      : undefined;
  if (read?._tag === 'Success' && Exit.isFailure(status)) {
    const cause = ensureError(Cause.squash(status.cause)).message;
    yield* Effect.logWarning(
      `Run ${runId}: its end with its last turn: ${cause}`,
    );
    const landed = runEndFromEvents(read.success, runId);
    if (landed !== null) return { recorded: true };
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
    status = yield* end({ ...requested, error, lastTurn: notice });
  }
  if (Exit.isSuccess(status)) return { recorded: status.value.recorded };
  // The last backstop, loud: the end alone, FAILED.
  const error = ensureError(Cause.squash(status.cause));
  const message = `The run's end was not saved: ${error.message}`;
  yield* Effect.logWarning(`Run ${runId}: ${message}`);
  const backstop = yield* end({
    runId,
    outcome: RUN_OUTCOME.FAILED,
    keepExistingOutcome: true,
    error: { kind: 'unexpected', message },
  });
  if (Exit.isFailure(backstop))
    yield* Effect.logError(`Run ${runId} reads as running: no end commits`);
  return yield* Effect.fail(error);
});
