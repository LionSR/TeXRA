/**
 * Run lifecycle operations: a run's registration, a resume's activation and
 * a run's end, each the rows one of the run's cells commits
 * (`RunHistory.open`), separate from the record accessors in
 * `runRecords.ts`.
 */

import { Cause, Effect, Exit } from 'effect';
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
  /**
   * The run's `run.description` row, written in the registration batch so it
   * is durable at birth (#9590 A4): child launchers pass the delegated task
   * label; a root run gets its AI-generated summary from
   * `generateSessionDescription` later, as a second row of the same type.
   */
  readonly description?: string;
  /** Who wrote that description: the model unless a fork copies a title
   *  its user gave. */
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
        ? { registration: rows }
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
      // A record read goes straight to the database, so a parent whose
      // `run.start` is still queued would read as absent. This empty
      // transaction is the barrier: it runs after every job queued before it,
      // answering for none of them.
      yield* session.log.transact([]);
      // The database refuses a parent that is closed or has no `run.start`;
      // this read only words the refusal before the transaction opens.
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
      // The worktree the fold spells is the run's working directory as a
      // bare path chip.
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
  /**
   * What the run produced. Absent for a backstop that ends a run whose flow
   * produced nothing (host exit, a stop of a parked run, a failed launch):
   * the row then carries an empty output. Absent by rule on the child-run
   * path (`finalizeChildRun`): a child's product is its per-turn delivery.
   */
  readonly output?: RunEndOutput;
  /** A child's last-turn settlement, committed with the run's end. */
  readonly settlement?: TransactionPart;
}

export type FinalizeRunResult =
  | {
      readonly ok: true;
      /**
       * The outcome that now stands on disk: the requested one, or the one
       * `keepExistingOutcome` retained from the run's own driver. A backstop
       * finalizer settles the rest of the run (its transcript groups) to this
       * value rather than to the one it asked for.
       */
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
 * A run's end, inside the publisher job `append` belongs to, through the
 * run's cell opened within it: what the run never applied consumed, the
 * loop's halt, what it left open closed, and its `run.end`, with a child's
 * last-turn settlement and its parent's delivery in the same append. A run
 * whose current lifecycle already ended this way writes only the
 * settlement; a resumed run ends again. A run that never opened has no
 * rows: only what its settlement owes another run is written.
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
  if (!rows.some((row) => row.type === 'run.start')) {
    const owed = co.rows.filter((row) => row.aggregateId !== target);
    if (owed.length > 0) yield* append(owed);
    return { persisted: outcome, recorded: false, after: co.committed };
  }
  // "Already ended" is about the run's current lifecycle (the rule of
  // `runEndFromEvents`): a resumed run ends again, even the same way, or
  // every `durableOutcome` reader keeps it RUNNING for want of the row.
  const ended = runEndFromEvents(rows, runId)?.outcome;
  const persisted =
    keepExistingOutcome === true && ended !== undefined ? ended : outcome;
  const cell = yield* session.runHistory.open(runId, { within: append });
  const alongside = Effect.succeed({ rows: co.rows, committed: Effect.void });
  if (ended === persisted || co.held === true) {
    if (ended === persisted && error !== undefined)
      yield* Effect.logWarning(`Run ${runId} had ended: ${error.message}`);
    yield* cell.append([], alongside);
    return { persisted, recorded: true, after: co.committed };
  }
  const { followUps } = yield* session.followUps.read(runId);
  yield* cell.append(
    [
      ...consumedRows(runId, followUps), // a request it never applied
      // The loop's halt, never apart from its end.
      ...rows.flatMap((row) =>
        row.type === 'run.position' ? [haltedPositionRow(row, persisted)] : [],
      ),
      // What the run left open closes with its end.
      ...session.trace.closure(runId, persisted),
      {
        type: 'run.end' as const,
        aggregateId: target,
        outcome: persisted,
        ...(error !== undefined ? { error } : {}),
        output: storedRunOutput(input.output ?? emptyRunEndOutput()),
      },
    ],
    alongside,
  );
  return { persisted, recorded: true, after: co.committed };
});

/**
 * End a run nothing drives any more, CANCELLED (an outcome it already wrote
 * stands), under its own claim: an owned child its parent's stop outlived.
 */
const retireRun = Effect.fn('retireRun')(function* (
  session: SessionHandle,
  runId: RunId,
) {
  const ended = yield* Effect.scoped(
    session.log.hold(runId, { ends: true }).pipe(
      Effect.andThen(
        finalizeRun(session, {
          runId,
          outcome: RUN_OUTCOME.CANCELLED,
          keepExistingOutcome: true,
        }),
      ),
    ),
  );
  if (!ended.ok) return yield* Effect.fail(ensureError(ended.error));
});

/**
 * HQ6: a run does not end while an open call of it owns a child that has not
 * ended. A stop or a backstop (`cascade`) retires such a child first, as the
 * live cascade would have; the run's own terminal, or a stop whose child is
 * still live in this process, is refused.
 */
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
    yield* retireRun(session, child.runId);
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
  // Rows the run published and the store refused fail it, whoever ends it.
  const lost = yield* session.trace.lost(runId);
  const status = yield* Effect.exit(
    session.log.transact((tx) =>
      endIn(session, tx.append, {
        ...input,
        outcome:
          lost !== undefined && outcome !== RUN_OUTCOME.CANCELLED
            ? RUN_OUTCOME.FAILED
            : outcome,
        error: input.error ?? lost,
      }).pipe(Effect.scoped),
    ),
  );
  if (Exit.isFailure(status))
    return { ok: false, error: Cause.squash(status.cause) };
  const { persisted, recorded, after } = status.value;
  yield* after;
  return { ok: true, outcome: persisted, recorded };
});
