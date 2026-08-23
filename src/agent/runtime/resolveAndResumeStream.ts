/** Host-neutral persisted-state resolution and resume orchestration. */
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { ExecutionLeaseActiveError } from '@agent/storage/executionLease';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript/StreamSnapshotStore';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from './SessionResumeRetrieval';
import { ResumeSessionUnavailableError } from './executeAgent';
import type { ExecutionRegistry } from './executionRegistry';
import type { SessionHandle } from './SessionHandle';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

interface ResolvedResumeState {
  readonly runState: AgentConfig;
  readonly executionId: ExecutionId;
  readonly parentStreamId?: StreamTabId;
}

type ResumeStateResolution =
  | { readonly status: 'resolved'; readonly state: ResolvedResumeState }
  | { readonly status: 'read-failed'; readonly error: unknown }
  | {
      readonly status: 'incomplete';
      readonly runState: AgentConfig | undefined;
      readonly executionId: ExecutionId | undefined;
    };

type UnresolvedResumeState = Exclude<
  ResumeStateResolution,
  { readonly status: 'resolved' }
>;

interface ResumeFailureDescription {
  readonly kind: 'lease-active' | 'not-resumable' | 'unexpected';
  readonly message: string;
}

/** One user-facing diagnosis for the two snapshot-backed GUI hosts. */
export function describeResumeStateResolution(
  resolution: UnresolvedResumeState,
): string {
  if (resolution.status === 'read-failed') {
    return `Persisted run state could not be read (${toErrorMessage(resolution.error)}). The resume was not started; retry once the storage issue is resolved.`;
  }
  return resolution.runState
    ? 'This stream has no persisted execution id. Start a new run instead.'
    : 'No persisted run state was found for this stream. Start a new run instead.';
}

/** Classify expected resume outcomes without making hosts recognize storage errors. */
export function describeResumeFailure(
  error: unknown,
): ResumeFailureDescription {
  if (error instanceof ExecutionLeaseActiveError) {
    return { kind: 'lease-active', message: error.message };
  }
  if (error instanceof ResumeSessionUnavailableError) {
    return { kind: 'not-resumable', message: error.message };
  }
  return {
    kind: 'unexpected',
    message: `Resume failed: ${toErrorMessage(error)}`,
  };
}

/** Claim and release the byte-identical GUI recovery ownership triad. */
export async function resumeStreamWithRecovery(
  session: Pick<SessionHandle, 'followUps'>,
  streamId: StreamTabId,
  run: (recovery: RecoveryContinuation) => Promise<boolean>,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  const claimedRecovery = recovery
    ? session.followUps.useRecovery(recovery)
    : session.followUps.claimRecovery(streamId, true);
  if (!claimedRecovery) return false;
  try {
    return await run(claimedRecovery);
  } finally {
    // The wrapped tool-use resume releases this same lease in its own finally;
    // release() is ownership-checked and returns false on the second call, so
    // this outer release is the no-op safety net for workflow/throw paths.
    session.followUps.release(claimedRecovery, 'recoverable');
  }
}

/** Resolve snapshot-backed metadata without collapsing read failure into absence.
 *
 * Preload-then-read (#9947): a stream whose sidecar record is not resident yet
 * must be seeded from disk before the synchronous reads can be trusted. Both
 * fields are re-read after the seed rather than filled in individually, so a
 * half-invalidated config/execution pair cannot survive into the resume.
 */
export async function resolveResumeStateFromSnapshots(
  snapshots: Pick<
    StreamSnapshotStore,
    'getRunMetadata' | 'getParentStreamId' | 'preload'
  >,
  streamId: StreamTabId,
): Promise<ResumeStateResolution> {
  let { config: runState, executionId } = snapshots.getRunMetadata(streamId);
  if (!runState || !executionId) {
    try {
      await snapshots.preload([streamId]);
    } catch (error) {
      return { status: 'read-failed', error };
    }
    ({ config: runState, executionId } = snapshots.getRunMetadata(streamId));
  }
  if (!runState || !executionId) {
    return { status: 'incomplete', runState, executionId };
  }
  const parentStreamId = snapshots.getParentStreamId(streamId);
  return {
    status: 'resolved',
    state: {
      runState,
      executionId,
      ...(parentStreamId !== undefined && { parentStreamId }),
    },
  };
}

export interface ResumeStreamPorts {
  /**
   * The registry of the session that owns this stream. A resume is refused,
   * not queued, while the stream is running or resuming in this process; the
   * lane below only keeps admitted generations from overlapping.
   */
  readonly executions: Pick<ExecutionRegistry, 'isActiveOrResuming'>;
  /** Monotone per-attempt cancellation signal: once true it stays true. */
  readonly isCancellationRequested?: () => boolean;
  resolveResumeState(streamId: StreamTabId): Promise<ResumeStateResolution>;
  reportResumeStateResolution?(
    streamId: StreamTabId,
    resolution: UnresolvedResumeState,
  ): void | Promise<void>;
  resumeToolUse(
    resume: ToolUseResumeData,
    recovery?: RecoveryContinuation,
  ): Promise<boolean>;
  executeWorkflow(
    config: AgentConfig,
    executionId: ExecutionId,
    modelHandlerCompatibilityKey:
      ModelHandlerCompatibilityKey | null | undefined,
  ): Promise<void>;
  reportNoResumableSession?(streamId: StreamTabId): void | Promise<void>;
  reportFailure?(streamId: StreamTabId, error: unknown): void | Promise<void>;
}

/**
 * Attempt to resume a WAITING / children-running stream from persisted state.
 *
 * The execution lane keeps the resumed generation from overlapping the one
 * before it; admission is decided here. A stream that is already running or
 * resuming in this process is refused, because a workflow run holds no
 * follow-up queue consumer and a queued resume would otherwise rerun it
 * after it finishes.
 */
export async function resolveAndResumeStream(
  streamId: StreamTabId,
  ports: ResumeStreamPorts,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  const isCancellationRequested = (): boolean =>
    ports.isCancellationRequested?.() === true;

  if (
    isCancellationRequested() ||
    ports.executions.isActiveOrResuming(streamId)
  )
    return false;

  try {
    const resolution = await ports.resolveResumeState(streamId);
    if (isCancellationRequested()) return false;
    if (resolution.status !== 'resolved') {
      try {
        await ports.reportResumeStateResolution?.(streamId, resolution);
      } catch {
        // An info-presenter failure must not become a resume-failure toast.
      }
      return false;
    }

    const resolved = resolution.state;
    const resume = await retrieveSessionResumeData(
      streamId,
      resolved.executionId,
      resolved.runState,
      { parentStreamId: resolved.parentStreamId },
    );
    if (isCancellationRequested()) return false;
    if (!resume) {
      await ports.reportNoResumableSession?.(streamId);
      return false;
    }
    // Re-check after the retrieval await: a launch of this stream may have
    // been admitted meanwhile, and the lane would queue, not refuse, this one.
    if (ports.executions.isActiveOrResuming(streamId)) return false;

    if (resume.type === 'toolUse') {
      return await ports.resumeToolUse(resume, recovery);
    }

    // Workflow launch owns stream acquisition and status transitions through
    // runAgent/buildAgentLaunchContext. Pre-marking the same stream RESUMING
    // here would make the launch reject itself as already in flight.
    await ports.executeWorkflow(
      resume.agentConfig,
      resume.executionId,
      resume.modelHandlerCompatibilityKey,
    );
    return true;
  } catch (error) {
    if (isCancellationRequested()) return false;
    try {
      await ports.reportFailure?.(streamId, error);
    } catch {
      // Presentation failures must not replace the resume failure they report.
    }
    return false;
  }
}
