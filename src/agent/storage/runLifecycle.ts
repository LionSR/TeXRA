/**
 * Run lifecycle operations.
 *
 * Business logic that orchestrates reads and writes across run stores.
 * Separated from RunKVStore to keep the store a clean storage interface
 * with no cross-store mutations or error-swallowing policies.
 */

import { Cause, Effect, Exit } from 'effect';

import { isRemoteAgent } from '@agent/index';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';
import { flowKey } from '@agent/node/persistedFlow';

import {
  RUN_OUTCOME,
  AgentCategory,
  RUN_PHASE,
  RUN_SUBSTATE,
  aggregateId,
  aggregateTarget,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
  type AggregateId,
  type RunId,
  type RunIdentity,
  type RunOutcome,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { launchWorktreeInfo } from '@utils/git/worktreeInfo';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import {
  getRunStore,
  getRunRecords,
  runMetaFromEvents,
  type ChildRecord,
} from './RunKVStore';
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
   * Display description persisted on `RunMeta.description` — the one
   * description authority (#9590 A4). Child-stream launchers pass the
   * delegated task label here so it is durable at birth; the later
   * `updateRunDescription` session event is display-only and no longer
   * writes a sidecar copy (#9590 Stage 6).
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
      const prior = yield* records.readMeta();
      if (prior !== null)
        releaseClaims = yield* session.acquireRunClaims(runId);
      // The database refuses a parent that is closed or has no `run.start`;
      // this read only words the refusal before the transaction opens.
      if (
        options.parentRunId !== undefined &&
        (yield* getRunRecords(session, options.parentRunId).readMeta()) === null
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
      if (prior === null) {
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
      if (
        options.identity.kind === 'agent' &&
        options.identity.tool === undefined
      )
        events.push({
          type: 'status',
          aggregateId: target,
          phase: RUN_PHASE.RUNNING,
          substate: RUN_SUBSTATE.STARTING,
          runStartedAt: Date.now(),
          cause: 'lifecycle',
        });
      if (options.description !== undefined)
        events.push(
          {
            type: 'run.description',
            aggregateId: target,
            description: options.description,
          },
          {
            type: 'updateRunDescription',
            aggregateId: target,
            description: options.description,
          },
        );
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
  const claims = yield* Effect.exit(session.acquireRunClaims(runId));
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

/**
 * The one rule for whether a run's resume checkpoint (`flow_<id>.json`)
 * survives finalization: **delete only on a genuinely COMPLETED run; keep it
 * otherwise.** A cancelled or failed run is the case a user resumes, so
 * destroying its checkpoint is data loss they cannot undo.
 *
 * Call sites should pass this rather than a literal. A hardcoded `'delete'`
 * is only correct when the caller can show the record is unresumable — see
 * the caveat below — and every such site should say why in a comment.
 *
 * Caveat, learned from #11314: preserving is not free. A record whose cursor
 * was never rewound (`cursor.nextNodeId === null`) fails
 * `ResumableFlowRecordSchema`'s refinement. `deriveResumability` reports it
 * as `unreadable`, which `classifyRun` maps to `unclassified`; only `history
 * delete` can remove it. Keeping such a record is strictly worse than deleting
 * it. So a caller that ends COMPLETED
 * *without* consuming its cursor must still report `'delete'`; this policy
 * covers the ordinary case where the outcome and the cursor agree.
 */
export function retainFlowRecordUnlessCompleted(
  resolved: RunOutcome,
): 'preserve' | 'delete' {
  return resolved === RUN_OUTCOME.COMPLETED ? 'delete' : 'preserve';
}

export interface FinalizeRunInput {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  readonly flowRecord: 'preserve' | 'delete';
  /**
   * Keep an outcome already on disk instead of replacing it. For a backstop
   * finalizer that does not own the run's result — the host-exit drain, which
   * can race the run's own driver across the same per-run meta lock —
   * the driver's outcome is the authoritative one. Read and write happen in
   * the same locked cycle, so "already settled" cannot go stale between them.
   */
  readonly keepExistingOutcome?: boolean;
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
 * The one terminal-persistence tail: persist the run's terminal outcome,
 * then apply the requested flow-record policy. Never throws — every
 * persistence failure comes back as an `ok: false` result (and through
 * `report`, when given).
 */
export const finalizeRun = Effect.fn('finalizeRun')(function* (
  session: SessionHandle,
  input: FinalizeRunInput,
): Effect.fn.Return<FinalizeRunResult> {
  const { runId, outcome, flowRecord, keepExistingOutcome } = input;
  const status = yield* Effect.exit(
    session.updateRecordFacts(runId, (rows) => {
      const meta = runMetaFromEvents(rows, runId);
      if (!meta) throw new Error(`Run metadata not found for ${runId}`);
      const persisted =
        keepExistingOutcome === true && meta.outcome !== undefined
          ? meta.outcome
          : outcome;
      return {
        events:
          meta.outcome === persisted
            ? []
            : [
                ...session.statusClosureFacts(runId, persisted),
                {
                  type: 'status' as const,
                  aggregateId: aggregateId('run', runId),
                  phase: persisted,
                  cause: 'lifecycle',
                },
              ],
        value: persisted,
      };
    }),
  );
  const deletion = yield* Effect.exit(
    flowRecord === 'delete'
      ? Effect.tryPromise({
          try: () =>
            runInSession(session, () =>
              getRunStore(runId).delete(flowKey(runId)),
            ),
          catch: ensureError,
        })
      : Effect.void,
  );
  if (Exit.isFailure(status) || Exit.isFailure(deletion)) {
    const failures = [
      ...(Exit.isFailure(status) ? [Cause.squash(status.cause)] : []),
      ...(Exit.isFailure(deletion) ? [Cause.squash(deletion.cause)] : []),
    ];
    const error =
      failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            `Terminal status and flow deletion failed for ${runId}`,
          );
    const outcomePersisted = Exit.isSuccess(status);
    input.report?.(
      new Error(
        outcomePersisted
          ? `Persisted ${outcome} status for run ${runId}, but failed to delete its flow record: ${toErrorMessage(error)}`
          : `Failed to persist ${outcome} terminal state for run ${runId}: ${toErrorMessage(error)}`,
        { cause: error },
      ),
    );
    return { ok: false, error, outcomePersisted };
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
  // rule `runMetaFromEvents` and the session fold apply.
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
