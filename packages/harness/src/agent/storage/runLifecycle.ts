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
 * configuration and no activation restates it. Its model stays the stored
 * row's: the model the run is on is the newest config's, which only a
 * switch moves, and its binding is the fold's, which a config without one
 * leaves as it was. Its caller holds the run's claim, so no other writer
 * can move the row between the read and the write.
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

/** A resume's activation: its `run.activate` and the grants it ends, as one
 *  batch. */
export const commitResumedActivation = (session: SessionHandle, runId: RunId) =>
  session.approvals
    .activationRows(runId)
    .pipe(
      Effect.flatMap((grants) =>
        session.log.transact([
          { type: 'run.activate', aggregateId: aggregateId('run', runId) },
          ...grants,
        ]),
      ),
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
  /** The approval grants the run starts with, on its `run.start`. */
  readonly grants?: ApprovalGrants;
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
    // A registration owns its run's claim: a birth takes it with its
    // `run.start`, a re-registration takes it over first; its driver keeps it.
    Effect.flatMap((events) =>
      session.log.transact((tx) =>
        (events.some((event) => event.type === 'run.start')
          ? Effect.void
          : tx.claim(runId)
        ).pipe(Effect.andThen(tx.append(events))),
      ),
    ),
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
   *  does not own the run's result. Read and write share one locked cycle. */
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
    };

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
        session.runs.end({
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
 * The one writer of the `run.end` row (one run model, 3.3), reached through
 * `Runs.end`. Read and write are one transaction, so a run whose current
 * lifecycle already ended this way writes nothing; a resumed run ends again.
 * Never fails: a persistence failure is `ok: false` (and `report`ed).
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
    return { ok: false, error };
  }
  // Rows the run published and the store refused fail it, whoever ends it.
  const lost = yield* session.trace.lost(runId);
  const requested =
    lost !== undefined && outcome !== RUN_OUTCOME.CANCELLED
      ? RUN_OUTCOME.FAILED
      : outcome;
  const error = input.error ?? lost;
  const status = yield* Effect.exit(
    session.log.transact((tx) =>
      Effect.gen(function* () {
        const co = yield* input.settlement ??
          Effect.succeed({ rows: [], committed: Effect.void, held: false });
        const rows = yield* session.log.records(runId);
        if (!rows.some((row) => row.type === 'run.start'))
          return yield* Effect.fail(
            new Error(`Run start not found for ${runId}`),
          );
        // "Already ended" is about the run's current lifecycle (the rule of
        // `runEndFromEvents`): a resumed run ends again, even the same way, or
        // every `durableOutcome` reader keeps it RUNNING for want of the row.
        const ended = runEndFromEvents(rows, runId)?.outcome;
        const persisted =
          keepExistingOutcome === true && ended !== undefined
            ? ended
            : requested;
        if (ended === persisted && lost !== undefined)
          yield* Effect.logWarning(`Run ${runId} had ended: ${lost.message}`);
        const commit = (end: readonly SessionEventDraft[]) =>
          tx
            .append([...co.rows, ...end])
            .pipe(Effect.as({ persisted, after: co.committed }));
        if (ended === persisted || co.held) return yield* commit([]);
        const { followUps } = yield* session.followUps.read(runId);
        return yield* commit([
          ...consumedRows(runId, followUps), // a request it never applied
          // The loop's halt, never apart from its end.
          ...rows.flatMap((row) =>
            row.type === 'run.position'
              ? [haltedPositionRow(row, persisted)]
              : [],
          ),
          // What the run left open closes with its end.
          ...session.trace.closure(runId, persisted),
          {
            type: 'run.end' as const,
            aggregateId: aggregateId('run', runId),
            outcome: persisted,
            ...(error !== undefined ? { error } : {}),
            output: storedRunOutput(input.output ?? emptyRunEndOutput()),
          },
        ]);
      }).pipe(Effect.scoped),
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
    return { ok: false, error };
  }
  yield* status.value.after;
  return { ok: true, outcome: status.value.persisted };
});
