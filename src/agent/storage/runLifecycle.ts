/**
 * Run lifecycle operations.
 *
 * Business logic that orchestrates the run's records across its aggregate:
 * registration, activation, finalization and the child listing, separate
 * from the record accessors in `runRecords.ts`.
 */

import { Cause, Effect, Exit } from 'effect';

import { isRemoteAgent } from '@agent/index';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';

import {
  RUN_OUTCOME,
  AgentCategory,
  RUN_PHASE,
  RUN_SUBSTATE,
  aggregateId,
  aggregateTarget,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
  emptyRunEndOutput,
  type AggregateId,
  type RunEnd,
  type RunEndOutput,
  type RunId,
  type RunIdentity,
  type RunOutcome,
  type SessionEvent,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { launchWorktreeInfo } from '@utils/git/worktreeInfo';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import {
  getRunRecords,
  runEndFromEvents,
  type ChildRecord,
} from './runRecords';
import {
  acquireFreshRunLease,
  acquireResumedRunLease,
  releaseOwnedRunLease,
} from './runLease';

function pinRunWorkingDirectory(record: RunRecord): RunRecord {
  // First non-blank candidate wins, stored verbatim (untrimmed) — trimming
  // here previously mangled resumed workflow paths (2e3197f92f).
  const workingDirectory = [
    record.workingDirectory,
    WorkspaceFS.getPath(),
  ].find((dir) => dir?.trim());
  return workingDirectory ? { ...record, workingDirectory } : record;
}

export interface RegisterRunOptions {
  /** The launching run: the whole parent edge, stamped on `run.start`. */
  readonly parentRunId?: RunId;
  readonly checkpointId?: string;
  readonly category?: AgentCategory;
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
}

/**
 * Register a new run: persist config, metadata, and parent linkage.
 * Awaits all writes before returning.
 */
export const registerRun = Effect.fn('registerRun')(function* (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
  agentName: string,
  options: RegisterRunOptions,
): Effect.fn.Return<void, Error> {
  const lease = yield* Effect.tryPromise({
    try: () => runInSession(session, () => acquireFreshRunLease(runId)),
    catch: ensureError,
  });
  let releaseClaims: Effect.Effect<void, Error> = Effect.void;
  const registration = yield* Effect.exit(
    Effect.gen(function* () {
      const records = getRunRecords(session, runId);
      const prior = yield* records.exists();
      if (prior)
        releaseClaims = yield* session.acquireClaims(aggregateId('run', runId));
      // The database refuses a parent that is closed or has no `run.start`;
      // this read only words the refusal before the transaction opens.
      if (
        options.parentRunId !== undefined &&
        !(yield* getRunRecords(session, options.parentRunId).exists())
      )
        return yield* Effect.fail(
          new Error(`Parent run ${options.parentRunId} is unavailable.`),
        );
      const pinned = runInSession(session, () =>
        pinRunWorkingDirectory(record),
      );
      const target = aggregateId('run', runId);
      const category = isAgentRunRecord(pinned)
        ? pinned.agentCategory
        : (options.category ?? AgentCategory.ToolUse);
      const events: SessionEventDraft[] = [];
      if (!prior) {
        events.push({
          type: 'run.start',
          aggregateId: target,
          identity: options.identity,
          userFollowUpSupport:
            options.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
          category,
          isRemote:
            options.identity.kind === 'agent' &&
            isRemoteAgent(options.identity.agent),
          worktree: launchWorktreeInfo(pinned.workingDirectory),
          parent:
            options.parentRunId === undefined
              ? null
              : { id: options.parentRunId },
          approvalPolicy: session.approvalPolicySnapshotFor(runId),
          checkpointId: options.checkpointId,
        });
      }
      events.push(
        {
          type: 'run.launchLabel',
          aggregateId: target,
          label: agentName,
        },
        {
          type: 'run.record',
          aggregateId: target,
          record: pinned,
        },
        {
          type: 'run.activate',
          aggregateId: target,
          category,
          ...(options.identity.kind === 'agent' &&
          options.identity.tool === undefined
            ? { isRemote: isRemoteAgent(options.identity.agent) }
            : {}),
        },
      );
      if (options.description !== undefined)
        events.push({
          type: 'run.description',
          aggregateId: target,
          description: options.description,
        });
      yield* session
        .commitRegistration(events)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.fail(ensureError(Cause.squash(cause))),
          ),
        );
    }),
  );
  if (Exit.isFailure(registration)) {
    const cause = Cause.squash(registration.cause);
    const claimRelease = yield* Effect.exit(releaseClaims);
    const release = yield* Effect.exit(
      lease === 'existing'
        ? Effect.void
        : Effect.tryPromise({
            try: () => runInSession(session, () => releaseOwnedRunLease(runId)),
            catch: ensureError,
          }),
    );
    const failures = [
      cause,
      ...[claimRelease, release].flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
      ),
    ];
    return yield* Effect.fail(
      failures.length > 1
        ? new AggregateError(
            failures,
            `Run registration and lease rollback failed for ${runId}`,
          )
        : ensureError(cause),
    );
  }
});

/** Admit a resumed turn and return rollback for only this admission's resources. */
export const acquireResumedRunOwnership = Effect.fn(
  'acquireResumedRunOwnership',
)(function* (
  session: SessionHandle,
  runId: RunId,
): Effect.fn.Return<Effect.Effect<void, Error>, Error> {
  const lease = yield* Effect.tryPromise({
    try: () => runInSession(session, () => acquireResumedRunLease(runId)),
    catch: ensureError,
  });
  const releaseLease =
    lease === 'existing'
      ? Effect.void
      : Effect.tryPromise({
          try: () => runInSession(session, () => releaseOwnedRunLease(runId)),
          catch: ensureError,
        });
  const claims = yield* Effect.exit(
    session.acquireClaims(aggregateId('run', runId)),
  );
  if (Exit.isFailure(claims)) {
    const release = yield* Effect.exit(releaseLease);
    return yield* Effect.fail(
      Exit.isFailure(release)
        ? new AggregateError(
            [Cause.squash(claims.cause), Cause.squash(release.cause)],
            `Run admission and lease rollback failed for ${runId}`,
          )
        : ensureError(Cause.squash(claims.cause)),
    );
  }
  return Effect.gen(function* () {
    const releasedClaims = yield* Effect.exit(claims.value);
    const releasedLease = yield* Effect.exit(releaseLease);
    const failures = [releasedClaims, releasedLease].flatMap((exit) =>
      Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
    );
    if (failures.length > 0)
      return yield* Effect.fail(
        new AggregateError(
          failures,
          `Run admission rollback failed for ${runId}`,
        ),
      );
  });
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
  /** Usage totals at the end of the run, once a round recorded usage. */
  readonly usage?: RunEnd['usage'];
  /**
   * What the run produced. Absent for a backstop that ends a run whose flow
   * produced nothing (host exit, a stop of a parked run, a failed launch):
   * the row then carries the empty output of the run's category. Also
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
  const status = yield* Effect.exit(
    session.updateRecordFacts(runId, (rows) => {
      const target = aggregateId('run', runId);
      const start = rows.find(
        (row): row is Extract<SessionEvent, { type: 'run.start' }> =>
          row.type === 'run.start' && row.aggregateId === target,
      );
      if (!start) throw new Error(`Run start not found for ${runId}`);
      // "Already ended" is a fact about the run's current lifecycle, not about
      // the aggregate (`runEndFromEvents` states the rule, and every reader
      // shares it): a resumed run has to end again even when it ends the same
      // way, or the fold, history and every `durableOutcome` reader keep it
      // RUNNING for want of a terminal row.
      const ended = runEndFromEvents(rows, runId)?.outcome;
      const persisted =
        keepExistingOutcome === true && ended !== undefined ? ended : outcome;
      if (ended === persisted) return { events: [], value: persisted };
      return {
        events: [
          ...session.streamClosureFacts(runId),
          {
            type: 'run.end' as const,
            aggregateId: target,
            outcome: persisted,
            ...(input.error !== undefined ? { error: input.error } : {}),
            ...(input.usage !== undefined ? { usage: input.usage } : {}),
            output: input.output ?? emptyRunEndOutput(start.category),
          },
        ],
        value: persisted,
      };
    }),
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

/** Read the canonical run configuration from the owning database. */
export const readPersistedRunRecord = (
  runId: RunId,
  session: SessionHandle,
): Effect.Effect<RunRecord | null, Error> =>
  getRunRecords(session, runId).readRunRecord();

/** Child labels and parentage come from the same immutable launch fact. */
export const readRunChildren = Effect.fn('readRunChildren')(function* (
  session: SessionHandle,
  runId: RunId,
): Effect.fn.Return<ChildRecord[], Error> {
  const rows = yield* session.readRunChildren(runId);
  const own = aggregateId('run', runId);
  const parent = rows.find(
    (row) => row.type === 'run.start' && row.aggregateId === own,
  );
  if (parent?.type !== 'run.start') return [];
  const closed = new Set(
    rows
      .filter((row) => row.type === 'run.removed')
      .map((row) => row.aggregateId),
  );
  if (closed.has(parent.aggregateId)) return [];
  // A `run.detach` severs the edge the child's `run.start` recorded, so a
  // detached child is no longer listed under its former parent: the same
  // rule the session fold applies.
  const detached = new Set(
    rows
      .filter((row) => row.type === 'run.detach')
      .map((row) => row.aggregateId),
  );
  const labels = new Map<AggregateId, string>();
  for (const row of rows) {
    if (row.type === 'run.launchLabel') labels.set(row.aggregateId, row.label);
  }
  return rows.flatMap((row) => {
    if (
      row.type !== 'run.start' ||
      row.parent === null ||
      row.parent.startCommit !== parent.commit ||
      row.parent.id !== runId ||
      closed.has(row.aggregateId) ||
      detached.has(row.aggregateId)
    )
      return [];
    const target = aggregateTarget(row.aggregateId);
    if (target.kind !== 'run') return [];
    const label = labels.get(row.aggregateId);
    if (label === undefined)
      throw new Error(`Child launch label missing for ${target.id}`);
    return [
      {
        id: target.id,
        agent: label,
        timestamp: new Date(row.at).toISOString(),
      },
    ];
  });
});
