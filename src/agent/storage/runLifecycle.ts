/**
 * Run lifecycle operations.
 *
 * Business logic that orchestrates the run's records across its aggregate:
 * registration, activation and finalization, separate from the record
 * accessors in `runRecords.ts`.
 */

import { Cause, Effect, Exit } from 'effect';
import stableStringify from 'safe-stable-stringify';

import type { RunRecord } from '@agent/core/definition/RunRecord';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { haltedPositionRow } from '@agent/runtime/loop/rows';

import {
  RUN_OUTCOME,
  RunRecordFieldsSchema,
  aggregateId,
  storedRunOutput,
  type ApprovalPolicySnapshot,
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
import type { DatabaseReadFailed } from '@shared/session/database';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
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
 * The `run.config` row an activation owes, or null when the run's newest
 * row already says it. A run's configuration is written with its
 * registration and afterwards only when it changes, so the newest row is the
 * configuration and no activation restates it. Its model stays the one the
 * run was launched with: the model the run is on is its snapshot's, which a
 * resume's configuration carries and this row never restates. Its caller
 * holds the run's claim, so no other writer can move the row between the
 * read and the write.
 */
export const configChange = Effect.fn('configChange')(function* (
  session: SessionHandle,
  runId: RunId,
  config: RunRecord,
) {
  const stored = yield* getRunRecords(session, runId).readRunRecord();
  const next = RunRecordFieldsSchema.parse(
    pinRunWorkingDirectory(
      stored?.model === undefined ? config : { ...config, model: stored.model },
      session.roots.workspace,
    ),
  );
  if (stored !== null && stableStringify(stored) === stableStringify(next))
    return null;
  return {
    type: 'run.config',
    aggregateId: aggregateId('run', runId),
    config: next,
  } satisfies SessionEventDraft;
});

/**
 * The approval snapshot a run's re-activation stamps. Enforcement is the
 * session's in-memory state, so a process holding none of the run's grants
 * (a resume in a new process) first rebuilds them from the run's last
 * durable snapshot (`SessionApprovals.restoreRun`) rather than stamping an
 * empty snapshot over them. The durable snapshot is the run's own record,
 * the newer of its `approval.policy` and the one its `run.start` carried.
 */
const reactivatedApprovalPolicy = (
  session: SessionHandle,
  runId: RunId,
): Effect.Effect<ApprovalPolicySnapshot, DatabaseReadFailed> =>
  session.readRunRecords(runId).pipe(
    Effect.map((rows) => {
      const latest = rows.findLast(
        (row) => row.type === 'approval.policy' || row.type === 'run.start',
      );
      const durable =
        latest?.type === 'approval.policy'
          ? latest.snapshot
          : latest?.approvalPolicy;
      if (durable) session.approvals.restoreRun(runId, durable);
      return session.approvalPolicySnapshotFor(runId);
    }),
  );

/**
 * A resume's activation: its `run.activate` with the approval snapshot
 * enforcement holds, as one batch (no `run.start` re-stamps the snapshot).
 */
export const commitResumedActivation = (session: SessionHandle, runId: RunId) =>
  reactivatedApprovalPolicy(session, runId).pipe(
    Effect.flatMap((snapshot) => {
      const target = aggregateId('run', runId);
      return session.commit([
        { type: 'run.activate', aggregateId: target },
        { type: 'approval.policy', aggregateId: target, snapshot },
      ]);
    }),
  );

interface RegisterRunOptions {
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
}

/**
 * Register a new run: persist config, metadata, and parent linkage.
 * Awaits all writes before returning.
 */
export const registerRun = Effect.fn('registerRun')(function* (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<void, Error> {
  return yield* registrationRows(session, runId, record, options).pipe(
    Effect.flatMap((events) => session.commitRegistration(events)),
    Effect.asVoid,
    // A registration that died wrote nothing, and the caller refuses the
    // launch on it like any other refused registration.
    Effect.catchDefect((defect) => Effect.fail(ensureError(defect))),
  );
});

/**
 * The rows that register a run, uncommitted: for a caller that commits them
 * with the run's first history in one batch, as a fork does, so no crash
 * leaves the run registered without the history it was registered with.
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
      // A record read goes straight to the database; it never queues behind
      // the publisher. A parent whose `run.start` is queued but uncommitted
      // therefore reads as absent here, and the refusal below would be about
      // a parent that is on its way in. This empty batch is the barrier: the
      // publisher is the one order, whether a fact was published detached or
      // awaited, so a job enqueued here runs after every publication queued
      // before it — while answering for none of them, which a settle could
      // not do without failing this child over some other fact its parent
      // lost.
      yield* session.commit([]);
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
      // bare path chip: the fold never shells out, so `branch`/`dirty`
      // stay absent.
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
        approvalPolicy: session.approvalPolicySnapshotFor(runId),
      });
    }
    events.push(config);
    events.push({ type: 'run.activate', aggregateId: target });
    // Enforcement is the session's in-memory policy; the row is its
    // projection. A re-registration writes no `run.start`, so the
    // activation re-stamps the snapshot enforcement now holds, rebuilt from
    // the durable one when this process holds none of the run's grants.
    if (prior)
      events.push({
        type: 'approval.policy',
        aggregateId: target,
        snapshot: yield* reactivatedApprovalPolicy(session, runId),
      });
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
  /**
   * Keep the outcome this lifecycle already wrote instead of replacing it.
   * For a backstop finalizer that does not own the run's result — the
   * host-exit drain, which can race the run's own driver across the same
   * per-run meta lock — the driver's outcome is the authoritative one. Read
   * and write happen in the same locked cycle, so "already settled" cannot go
   * stale between them.
   */
  readonly keepExistingOutcome?: boolean;
  /** The classified error behind a FAILED outcome, when the run has one. */
  readonly error?: RunEnd['error'];
  /**
   * What the run produced. Absent for a backstop that ends a run whose flow
   * produced nothing (host exit, a stop of a parked run, a failed launch):
   * the row then carries an empty output. Also
   * absent, by rule rather than omission, on the child-run path
   * (`finalizeChildRun` in `src/tools/delegation/childRun.ts`): a child's
   * product is its per-turn delivery to its parent, not a flow output.
   */
  readonly output?: RunEndOutput;
  /**
   * Where a persistence failure is reported, wrapped in one worded Error.
   * `finalizeRun` never throws; a caller with its own logging reads the
   * result instead.
   */
  readonly report?: (error: Error) => void;
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
    }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly outcomePersisted: boolean;
    };

/**
 * End a run nothing drives any more, CANCELLED (an outcome it already wrote
 * stands), under its own claim: an owned child its parent's stop outlived,
 * or one a person's outcome decision left behind.
 */
export const retireRun = Effect.fn('retireRun')(function* (
  session: SessionHandle,
  runId: RunId,
) {
  const ended = yield* Effect.scoped(
    session.holdRunClaim(runId).pipe(
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
 * The one terminal-persistence tail, and the one writer of the `run.end` row
 * (one run model, section 3.3): persist the run's terminal fact. The run's
 * rows live until explicit deletion (C9); nothing is removed beside the row.
 * Read and write share one locked cycle, so
 * a run whose *current* lifecycle already ended with this outcome writes
 * nothing; a resumed run ends again. Never throws — every persistence
 * failure comes back as an `ok: false` result (and through
 * `report`, when given).
 */
export const finalizeRun = Effect.fn('finalizeRun')(function* (
  session: SessionHandle,
  input: FinalizeRunInput,
): Effect.fn.Return<FinalizeRunResult> {
  const { runId, outcome, keepExistingOutcome } = input;
  const owned = yield* Effect.exit(
    endOwnedChildren(session, runId, keepExistingOutcome === true),
  );
  if (Exit.isFailure(owned)) {
    const error = ensureError(Cause.squash(owned.cause));
    input.report?.(error);
    return { ok: false, error, outcomePersisted: false };
  }
  const status = yield* Effect.exit(
    session.updateRecordFacts(runId, (rows) =>
      Effect.gen(function* () {
        const target = aggregateId('run', runId);
        const start = rows.find((row) => row.type === 'run.start');
        if (start?.type !== 'run.start')
          return yield* Effect.fail(
            new Error(`Run start not found for ${runId}`),
          );
        // "Already ended" is about the run's current lifecycle (the rule of
        // `runEndFromEvents`): a resumed run ends again, even the same way, or
        // every `durableOutcome` reader keeps it RUNNING for want of the row.
        const ended = runEndFromEvents(rows, runId)?.outcome;
        const persisted =
          keepExistingOutcome === true && ended !== undefined ? ended : outcome;
        if (ended === persisted) return { events: [], value: persisted };
        return {
          events: [
            // The loop's halt, never apart from its end.
            ...rows.flatMap((row) =>
              row.type === 'run.position'
                ? [haltedPositionRow(row, persisted)]
                : [],
            ),
            ...session.streamClosureFacts(runId),
            {
              type: 'run.end' as const,
              aggregateId: target,
              outcome: persisted,
              ...(input.error !== undefined ? { error: input.error } : {}),
              output: storedRunOutput(input.output ?? emptyRunEndOutput()),
            },
          ],
          value: persisted,
        };
      }),
    ),
  );
  if (Exit.isFailure(status)) {
    const error = Cause.squash(status.cause);
    input.report?.(
      new Error(
        `Failed to persist ${outcome} terminal state for run ${runId}: ${toErrorMessage(error)}`,
        { cause: error },
      ),
    );
    return { ok: false, error, outcomePersisted: false };
  }
  return { ok: true, outcome: status.value };
});
