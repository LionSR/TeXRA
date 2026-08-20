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
import {
  ResumeAdmissionCancelledError,
  ResumeSessionUnavailableError,
} from './executeAgent';
import type { SessionHandle } from './SessionHandle';
import type { StreamStatusMachine } from './StreamStatusService';
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
   * The status machine of the session that owns this stream. The active/resuming
   * guards must read the machine the run actually writes; reading the
   * process-global default left both guards permanently false in multi-session
   * hosts.
   */
  readonly streamStatus: Pick<StreamStatusMachine, 'isActiveOrResuming'>;
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

/** Attempt to resume a WAITING / children-running stream from persisted state. */
export async function resolveAndResumeStream(
  streamId: StreamTabId,
  ports: ResumeStreamPorts,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  const isCancellationRequested = (): boolean =>
    ports.isCancellationRequested?.() === true;

  if (
    isCancellationRequested() ||
    ports.streamStatus.isActiveOrResuming(streamId)
  ) {
    return false;
  }

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

    // Re-check after the async retrieval window: `resumeInFlight` blocks only a
    // second resume entry, not a concurrent non-resume run launch that flips
    // this stream active/resuming while retrieval is awaited.
    if (ports.streamStatus.isActiveOrResuming(streamId)) return false;

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
    // Shipped hosts that pass the lease guard share this attempt's monotone
    // cancellation latch, so the preceding check handles their lost-admission
    // path. Keep this fallback for a future host that supplies the lease guard
    // without the optional cancellation port: it must still fail silently
    // rather than toast.
    if (error instanceof ResumeAdmissionCancelledError) return false;
    try {
      await ports.reportFailure?.(streamId, error);
    } catch {
      // Presentation failures must not replace the resume failure they report.
    }
    return false;
  }
}
