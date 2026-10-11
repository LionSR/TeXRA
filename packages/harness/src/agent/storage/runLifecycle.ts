/** A run's registration, a resume's activation and a run's end: the rows
 *  its cell commits (record accessors: `runRecords.ts`). */

import { Cause, Effect, Exit, Result } from 'effect';
import stableStringify from 'safe-stable-stringify';

import type { RunRecord } from '@agent/core/definition/RunRecord';
import type { TransactionPart } from '@agent/runtime/childSettlement';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { consumedRows, haltedPositionRow } from '@agent/runtime/loop/rows';
import {
  NO_APPROVAL_GRANTS,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';

import {
  RUN_OUTCOME,
  RunRecordFieldsSchema,
  aggregateId,
  storedRunOutput,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
  emptyRunEndOutput,
  type RunEnd,
  type RunEndOutput,
  type RunId,
  type RunIdentity,
  type RunOutcome,
  type RunProvenance,
  type UserFollowUpSupport,
} from '@shared/schemas';
import type { Append } from '@shared/session/sessionEvents';
import type { RunInputDraft } from '@shared/session/runStateFold';
import { ensureError } from '@utils/errors/errorMessage';
import {
  getRunRecords,
  openOwnedChildren,
  runEndFromEvents,
} from './runRecords';

function pinRunWorkingDirectory(
  record: RunRecord,
  workspaceRoot: string | undefined,
): RunRecord {
  // First non-blank candidate wins, stored verbatim (untrimmed) — trimming
  // here previously mangled resumed workflow paths (2e3197f92f).
  const workingDirectory = [record.workingDirectory, workspaceRoot].find(
    (dir) => dir?.trim(),
  );
  return workingDirectory ? { ...record, workingDirectory } : record;
}

/**
 * A resume's activation: its `run.activate`, the grants it ends, and the
 * `run.config` it owes when its configuration changed (the newest row is
 * the configuration; its model stays the stored one, which only a switch
 * moves). Read inside the activation's transaction, under its claim.
 */
export const activationRows = Effect.fn('activationRows')(function* (
  session: SessionHandle,
  runId: RunId,
  config: RunRecord,
): Effect.fn.Return<readonly SessionEventDraft[], Error> {
  const target = aggregateId('run', runId);
  const stored = yield* getRunRecords(session, runId).readRunRecord();
  const next = RunRecordFieldsSchema.parse(
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
  /** The parent's tool card whose call launches this run. */
  readonly parentCard?: string;
  /** That call's id: the call that owns this run until it detaches. */
  readonly parentCallId?: string;
  /** The run's identity, declared by the launch site — the durable authority. */
  readonly identity: RunIdentity;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  readonly userFollowUpSupport?: UserFollowUpSupport;
  /** The run's `run.description`, durable at birth (#9590 A4): a child's
   *  task label; a root's summary comes later as a second row. */
  readonly description?: string;
  /** Who wrote it: the model, unless a fork copies its user's title. */
  readonly descriptionBy?: 'model' | 'user';
  /** Where the run's history came from: a fork's source and cut. */
  readonly provenance?: RunProvenance;
  /** The approval grants the run starts with, on its `run.start`. */
  readonly grants?: ApprovalGrants;
}

/**
 * Register a run whose loop is not this process's (a process child: an
 * agent CLI, background bash): its registration alone, through its cell. A
 * birth takes the claim with its `run.start`; a re-registration takes it
 * over first, as a resume does. A run this process's loop drives registers
 * with its opening instead (`LaunchEntry`).
 */
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
  }).pipe(
    // A registration that died wrote nothing, and the caller refuses the
    // launch on it like any other refused registration.
    Effect.catchDefect((defect) => Effect.fail(ensureError(defect))),
  );
});

/**
 * The rows that register a run, uncommitted: its `run.start` first for a
 * birth, which a caller commits with the run's first history in one batch
 * (a fork, a fresh run's opening), so no crash leaves the run registered
 * without the history it was registered with.
 */
export const registrationRows = Effect.fn('registrationRows')(function* (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<readonly SessionEventDraft[], Error> {
  return yield* Effect.gen(function* () {
    // A re-registration writes into a run that already has rows; the
    // registration takes the run's claim over as it commits.
    const prior = yield* getRunRecords(session, runId).exists();
    if (options.parentRunId !== undefined) {
      // A barrier first: a parent whose `run.start` is still queued reads
      // as absent. The database refuses a closed or unborn parent; this
      // read only words the refusal before the transaction opens.
      yield* session.log.transact([]);
      if (!(yield* getRunRecords(session, options.parentRunId).exists()))
        return yield* Effect.fail(
          new Error(`Parent run ${options.parentRunId} is unavailable.`),
        );
    }
    const pinned = pinRunWorkingDirectory(record, session.roots.workspace);
    const target = aggregateId('run', runId);
    // A registration, first or again, opens the run with its configuration
    // in the batch that takes the claim: nothing is compared before the
    // claim is held, so a takeover never skips the row on a stale read.
    const config = {
      type: 'run.config',
      aggregateId: target,
      config: RunRecordFieldsSchema.parse(pinned),
    } satisfies SessionEventDraft;
    const events: SessionEventDraft[] = [];
    if (!prior) {
      // The worktree chip: the run's working directory as a bare path.
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
                callId: options.parentCallId ?? null,
              },
        provenance: options.provenance ?? null,
        ...(options.parentCard !== undefined && {
          parentCard: options.parentCard,
        }),
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
  }).pipe(Effect.catchDefect((defect) => Effect.fail(ensureError(defect))));
});

export interface FinalizeRunInput {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  /** Keep the outcome already written: a backstop (the host-exit drain)
   *  does not own the run's result. Read and write share one transaction. */
  readonly keepExistingOutcome?: boolean;
  /** The classified error behind a FAILED outcome, when the run has one. */
  readonly error?: RunEnd['error'];
  /** What the run produced; absent (an empty output) for a backstop, and
   *  for a child, whose product is its per-turn delivery. */
  readonly output?: RunEndOutput;
  /** A child's last-turn settlement, committed with the run's end. */
  readonly settlement?: TransactionPart;
}

export type FinalizeRunResult =
  | {
      readonly ok: true;
      /** The outcome that stands on disk: the requested one, or the one
       *  `keepExistingOutcome` retained, which a backstop settles to. */
      readonly outcome: RunOutcome;
      /** False for a run that never opened: it has no rows, so nothing of
       *  it was written, and its failure is its launch's to report. */
      readonly recorded: boolean;
    }
  | {
      readonly ok: false;
      readonly error: unknown;
    };

/**
 * A run's end in `append`'s job, through its cell: its unapplied input
 * consumed, its halt, what it left open, its `run.end`, a child's last
 * settlement and delivery. An ended lifecycle writes only the settlement; an
 * unborn run, nothing; rows that do not fold, loudly, only rows no fold
 * reads. A store failure fails the end.
 */
export const endIn = Effect.fn('endIn')(function* (
  session: SessionHandle,
  append: Append,
  input: FinalizeRunInput,
) {
  const { runId, outcome, keepExistingOutcome, error } = input;
  const target = aggregateId('run', runId);
  const co = yield* input.settlement ??
    Effect.succeed({ rows: [], committed: Effect.void, held: false });
  const rows = yield* session.log.records(runId);
  // A run never born has nothing to end: its launch reports the failure.
  if (!rows.some((row) => row.type === 'run.start'))
    return { persisted: outcome, recorded: false, after: Effect.void };
  // "Already ended" is about the run's current lifecycle (the rule of
  // `runEndFromEvents`): a resumed run ends again, even the same way, or
  // every `durableOutcome` reader keeps it RUNNING for want of the row.
  const ended = runEndFromEvents(rows, runId)?.outcome;
  const persisted =
    keepExistingOutcome === true && ended !== undefined ? ended : outcome;
  const settled = ended === persisted || co.held === true;
  if (ended === persisted && error !== undefined)
    yield* Effect.logWarning(`Run ${runId} had ended: ${error.message}`);
  // The loop's halt, never apart from its end, through the run's cell; the
  // input it never applied, what it left open and its `run.end` beside it.
  const halt = settled
    ? []
    : rows.flatMap((row) =>
        row.type === 'run.position' ? [haltedPositionRow(row, persisted)] : [],
      );
  const closing: readonly RunInputDraft[] = settled
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
          ...(error !== undefined ? { error } : {}),
          output: storedRunOutput(input.output ?? emptyRunEndOutput()),
        },
      ];
  const result = { persisted, recorded: true, after: co.committed };
  const beside = [...closing, ...co.rows];
  const cell = yield* Effect.result(
    session.runHistory.open(runId, { within: append }),
  );
  const alongside = Effect.succeed({ rows: beside, committed: Effect.void });
  if (Result.isSuccess(cell))
    return yield* Effect.as(cell.success.append(halt, alongside), result);
  if (cell.failure._tag !== 'RunHistoryRefused') return yield* cell.failure;
  yield* Effect.logWarning(
    `Run ${runId} ends unloaded: ${cell.failure.message}`,
  );
  yield* session.runHistory.appendIn(append, beside);
  return result;
});

/** HQ6: no run ends while its open call owns a child that has not ended. A
 *  stop or backstop (`cascade`) retires such a child first; the run's own
 *  terminal, or a stop whose child is live here, is refused. */
const endOwnedChildren = Effect.fn('endOwnedChildren')(function* (
  session: SessionHandle,
  runId: RunId,
  cascade: boolean,
) {
  for (const child of yield* openOwnedChildren(session, runId)) {
    if (!cascade || session.runs.isLive(child.runId))
      return yield* Effect.fail(
        new Error(
          `Run ${runId} cannot end while its open call ${child.callId} owns run ${child.runId}, which has not ended`,
        ),
      );
    // Retired CANCELLED (an outcome it wrote stands), under its own claim.
    const ended = yield* Effect.scoped(
      Effect.andThen(
        session.log.hold(child.runId, { ends: true }),
        finalizeRun(session, {
          runId: child.runId,
          outcome: RUN_OUTCOME.CANCELLED,
          keepExistingOutcome: true,
        }),
      ),
    );
    if (!ended.ok) return yield* Effect.fail(ensureError(ended.error));
  }
});

/**
 * The one writer of a run's end ({@link endIn}, in one transaction of its
 * own), for its driver's terminal and for an end no driver writes. Never
 * fails: a persistence failure is `ok: false`.
 */
export const finalizeRun = Effect.fn('finalizeRun')(function* (
  session: SessionHandle,
  input: FinalizeRunInput,
): Effect.fn.Return<FinalizeRunResult> {
  const { runId, outcome, keepExistingOutcome } = input;
  const owned = yield* Effect.exit(
    endOwnedChildren(session, runId, keepExistingOutcome === true),
  );
  if (Exit.isFailure(owned))
    return { ok: false, error: ensureError(Cause.squash(owned.cause)) };
  const end = (ending: FinalizeRunInput) =>
    Effect.exit(
      session.log.transact((tx) =>
        endIn(session, tx.append, ending).pipe(Effect.scoped),
      ),
    );
  // Rows the run published and the store refused fail it, whoever ends it.
  const lost = yield* session.trace.lost(runId);
  const failed = lost !== undefined && outcome !== RUN_OUTCOME.CANCELLED;
  const { settlement, ...requested } = {
    ...input,
    outcome: failed ? RUN_OUTCOME.FAILED : outcome,
    error: input.error ?? lost,
  };
  let status = yield* end({ ...requested, settlement });
  // A refused settlement: the end, its outcome kept, without it, loudly.
  if (Exit.isFailure(status) && settlement !== undefined) {
    yield* Effect.logWarning(`Run ${runId}: its settlement was not saved`).pipe(
      Effect.annotateLogs({ data: Cause.squash(status.cause) }),
    );
    status = yield* end(requested);
  }
  if (Exit.isSuccess(status)) {
    const { persisted, recorded, after } = status.value;
    yield* after;
    return { ok: true, outcome: persisted, recorded };
  }
  // The last backstop, loud: the end alone, FAILED.
  const error = Cause.squash(status.cause);
  const message = `The run's end was not saved: ${ensureError(error).message}`;
  yield* Effect.logWarning(`Run ${runId}: ${message}`);
  const backstop = yield* end({
    runId,
    outcome: RUN_OUTCOME.FAILED,
    keepExistingOutcome: true,
    error: { kind: 'unexpected', message },
  });
  if (Exit.isFailure(backstop))
    yield* Effect.logError(`Run ${runId} reads as running: no end commits`);
  return { ok: false, error };
});
