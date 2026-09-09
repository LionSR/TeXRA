/**
 * Execution lifecycle operations.
 *
 * Business logic that orchestrates reads and writes across execution stores.
 * Separated from ExecutionKVStore to keep the store a clean storage interface
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

import { createLog } from '@logger/logUtils';
import { type WorkspaceRoots } from '@platform/workspaceRoots';
import {
  RUN_OUTCOME,
  AgentCategory,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  aggregateId,
  aggregateTarget,
  type SessionEventDraft,
  USER_FOLLOW_UP_SUPPORT,
  type AggregateId,
  type ExecutionId,
  type ExecutionMeta,
  type RunIdentity,
  type RunOutcome,
  type StreamTabId,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { KeyedMutex } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { launchWorktreeInfo } from '@utils/git/worktreeInfo';
import { ensureError } from '@utils/errors/errorMessage';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  getExecutionStore,
  getExecutionRecords,
  executionMetaFromEvents,
  type ChildRecord,
} from './ExecutionKVStore';
import {
  acquireFreshExecutionLease,
  acquireResumedExecutionLease,
  releaseOwnedExecutionLease,
} from './executionLease';

const log = createLog('ExecutionLifecycle');

function pinExecutionWorkingDirectory(record: RunRecord): RunRecord {
  // First non-blank candidate wins, stored verbatim (untrimmed) — trimming
  // here previously mangled resumed workflow paths (2e3197f92f).
  const workingDirectory = [
    record.workingDirectory,
    WorkspaceFS.getPath(),
  ].find((dir) => dir?.trim());
  return workingDirectory ? { ...record, workingDirectory } : record;
}

/** Parentage is projected from the declared creation edge. */
export const hasPersistedParent = (
  executionId: ExecutionId,
  session: SessionHandle,
): Effect.Effect<boolean, Error> =>
  getExecutionRecords(session, executionId)
    .readMeta()
    .pipe(Effect.map((meta) => meta?.parentExecutionId !== undefined));

export const getPersistedUserFollowUpSupport = (
  executionId: ExecutionId,
  session: SessionHandle,
): Effect.Effect<UserFollowUpSupport, Error> =>
  getExecutionRecords(session, executionId)
    .readMeta()
    .pipe(
      Effect.map(
        (meta) =>
          meta?.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      ),
    );

export interface RegisterExecutionOptions {
  readonly parentStreamId?: StreamTabId;
  readonly checkpointId?: string;
  readonly background?: boolean;
  readonly category?: AgentCategory;
  readonly streamId: StreamTabId;
  /** The run's identity, declared by the launch site — the durable authority. */
  readonly identity: RunIdentity;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  readonly userFollowUpSupport?: UserFollowUpSupport;
  readonly parentExecutionId?: ExecutionId;
  /**
   * Display description persisted on `ExecutionMeta.description` — the one
   * description authority (#9590 A4). Child-stream launchers pass the
   * delegated task label here so it is durable at birth; the later
   * `updateStreamDescription` session event is display-only and no longer
   * writes a sidecar copy (#9590 Stage 6).
   */
  readonly description?: string;
}

/**
 * Register a new execution: persist config, metadata, and parent linkage.
 * Awaits all writes before returning.
 */
export const registerExecution = Effect.fn('registerExecution')(function* (
  session: SessionHandle,
  executionId: ExecutionId,
  record: RunRecord,
  agentName: string,
  options: RegisterExecutionOptions,
): Effect.fn.Return<void, Error> {
  const lease = yield* Effect.tryPromise({
    try: () =>
      runInSession(session, () => acquireFreshExecutionLease(executionId)),
    catch: ensureError,
  });
  let releaseClaims: Effect.Effect<void, Error> = Effect.void;
  const registration = yield* Effect.exit(
    Effect.gen(function* () {
      const records = getExecutionRecords(session, executionId);
      const prior = yield* records.readMeta();
      if (prior !== null)
        releaseClaims = yield* session.acquireExecutionClaims(
          executionId,
          options.streamId,
        );
      const parent =
        options.parentExecutionId === undefined
          ? null
          : yield* getExecutionRecords(
              session,
              options.parentExecutionId,
            ).readMeta();
      if (options.parentExecutionId !== undefined && parent === null)
        return yield* Effect.fail(
          new Error(
            `Parent execution ${options.parentExecutionId} is unavailable.`,
          ),
        );
      const pinned = runInSession(session, () =>
        pinExecutionWorkingDirectory(record),
      );
      const target = aggregateId('stream', options.streamId);
      const category = isAgentRunRecord(pinned)
        ? pinned.agentCategory
        : (options.category ?? AgentCategory.ToolUse);
      const background =
        options.background ?? options.parentExecutionId !== undefined;
      const events: SessionEventDraft[] = [];
      if (prior === null) {
        events.push({
          type: 'run.start',
          aggregateId: target,
          executionId,
          identity: options.identity,
          userFollowUpSupport:
            options.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
          category,
          isRemote:
            options.identity.kind === 'agent' &&
            isRemoteAgent(options.identity.agent),
          worktree: launchWorktreeInfo(pinned.workingDirectory),
          parentStreamId:
            parent === null ? options.parentStreamId : parent.streamId,
          background,
          approvalPolicy: session.approvalPolicySnapshotFor(options.streamId),
          checkpointId: options.checkpointId,
        });
      }
      events.push(
        {
          type: 'execution.launchLabel',
          aggregateId: aggregateId('execution', executionId),
          label: agentName,
        },
        {
          type: 'execution.config',
          aggregateId: aggregateId('execution', executionId),
          record: pinned,
        },
        {
          type: 'run.activate',
          aggregateId: target,
          category,
          background,
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
          phase: STREAM_PHASE.RUNNING,
          substate: STREAM_SUBSTATE.STARTING,
          runStartedAt: Date.now(),
          cause: 'lifecycle',
        });
      if (options.description !== undefined)
        events.push(
          {
            type: 'execution.description',
            aggregateId: aggregateId('execution', executionId),
            description: options.description,
          },
          {
            type: 'updateStreamDescription',
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
            try: () =>
              runInSession(session, () =>
                releaseOwnedExecutionLease(executionId),
              ),
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
            `Execution registration and lease rollback failed for ${executionId}`,
          )
        : ensureError(cause),
    );
  }
});

/** Admit a resumed turn and return rollback for only this admission's resources. */
export const acquireResumedExecutionOwnership = Effect.fn(
  'acquireResumedExecutionOwnership',
)(function* (
  session: SessionHandle,
  executionId: ExecutionId,
  streamId: StreamTabId,
): Effect.fn.Return<Effect.Effect<void, Error>, Error> {
  const lease = yield* Effect.tryPromise({
    try: () =>
      runInSession(session, () => acquireResumedExecutionLease(executionId)),
    catch: ensureError,
  });
  const releaseLease =
    lease === 'existing'
      ? Effect.void
      : Effect.tryPromise({
          try: () =>
            runInSession(session, () =>
              releaseOwnedExecutionLease(executionId),
            ),
          catch: ensureError,
        });
  const claims = yield* Effect.exit(
    session.acquireExecutionClaims(executionId, streamId),
  );
  if (Exit.isFailure(claims)) {
    const release = yield* Effect.exit(releaseLease);
    return yield* Effect.fail(
      Exit.isFailure(release)
        ? new AggregateError(
            [Cause.squash(claims.cause), Cause.squash(release.cause)],
            `Execution admission and lease rollback failed for ${executionId}`,
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
          `Execution admission rollback failed for ${executionId}`,
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

export interface FinalizeExecutionInput {
  readonly executionId: ExecutionId;
  readonly outcome: RunOutcome;
  readonly flowRecord: 'preserve' | 'delete';
  /**
   * Keep an outcome already on disk instead of replacing it. For a backstop
   * finalizer that does not own the run's result — the host-exit drain, which
   * can race the run's own driver across the same per-execution meta lock —
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

export type FinalizeExecutionResult =
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
  input: FinalizeExecutionInput,
): Effect.fn.Return<FinalizeExecutionResult> {
  const { executionId, outcome, flowRecord, keepExistingOutcome } = input;
  const status = yield* Effect.exit(
    session.updateRecordFacts(executionId, (rows) => {
      const meta = executionMetaFromEvents(rows, executionId);
      if (!meta)
        throw new Error(`Execution metadata not found for ${executionId}`);
      const persisted =
        keepExistingOutcome === true && meta.outcome !== undefined
          ? meta.outcome
          : outcome;
      return {
        events:
          meta.outcome === persisted
            ? []
            : [
                ...session.statusClosureFacts(meta.streamId, persisted),
                {
                  type: 'status' as const,
                  aggregateId: aggregateId('stream', meta.streamId),
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
              getExecutionStore(executionId).delete(flowKey(executionId)),
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
            `Terminal status and flow deletion failed for ${executionId}`,
          );
    const outcomePersisted = Exit.isSuccess(status);
    input.report?.(
      new Error(
        outcomePersisted
          ? `Persisted ${outcome} status for execution ${executionId}, but failed to delete its flow record: ${toErrorMessage(error)}`
          : `Failed to persist ${outcome} terminal state for execution ${executionId}: ${toErrorMessage(error)}`,
        { cause: error },
      ),
    );
    return { ok: false, error, outcomePersisted };
  }
  return { ok: true, outcome: status.value };
});

/**
 * The execution→stream foreign key: the `streamId` stamped on execution
 * metadata at registration. A row without one has no persisted stream, so
 * archive readers never fall back to re-deriving a stream from names or
 * sidecar scans. This is the ONE resolution site; completed-run readers
 * and the trace assembler share it instead of each re-deriving
 * `readMeta() → meta.streamId`.
 *
 * The resolved branch carries the already-read `meta` so a caller that also
 * needs other metadata fields (the trace assembler) does not pay a second
 * `readMeta()`. Absence is a plain `null`: no execution metadata at all and
 * metadata predating stamped streams are the same answer to every caller.
 */
export const resolveStreamForExecution = Effect.fn('resolveStreamForExecution')(
  function* (executionId: ExecutionId, session: SessionHandle) {
    const meta = yield* getExecutionRecords(session, executionId).readMeta();
    return meta ? { streamId: meta.streamId, meta } : null;
  },
);

/** Read the canonical run configuration from the owning database. */
export const readExecutionRunRecord = (
  executionId: ExecutionId,
  session: SessionHandle,
): Effect.Effect<RunRecord | null, Error> =>
  getExecutionRecords(session, executionId).readRunRecord();

/** Child labels and parentage come from the same immutable launch fact. */
export const readExecutionChildren = Effect.fn('readExecutionChildren')(
  function* (
    session: SessionHandle,
    executionId: ExecutionId,
  ): Effect.fn.Return<ChildRecord[], Error> {
    const rows = yield* session.readExecutionChildren(executionId);
    const parent = rows.find(
      (row) => row.type === 'run.start' && row.executionId === executionId,
    );
    if (parent?.type !== 'run.start') return [];
    const closed = new Set(
      rows
        .filter((row) => row.type === 'stream.removed')
        .map((row) => row.aggregateId),
    );
    if (closed.has(parent.aggregateId)) return [];
    const labels = new Map<AggregateId, string>();
    for (const row of rows) {
      if (row.type === 'execution.launchLabel')
        labels.set(row.aggregateId, row.label);
    }
    return rows.flatMap((row) => {
      if (
        row.type !== 'run.start' ||
        row.parentStartCommit !== parent.commit ||
        row.parentStreamId !== aggregateTarget(parent.aggregateId).id ||
        closed.has(row.aggregateId)
      )
        return [];
      const label = labels.get(aggregateId('execution', row.executionId));
      if (label === undefined)
        throw new Error(`Child launch label missing for ${row.executionId}`);
      return [
        {
          id: row.executionId,
          agent: label,
          timestamp: new Date(row.at).toISOString(),
        },
      ];
    });
  },
);
