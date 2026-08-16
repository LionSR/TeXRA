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
import type { SessionHandle } from './SessionHandle';
import type { StreamStatusMachine } from './StreamStatusService';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

interface ResolvedResumeState {
  readonly runState: AgentConfig;
  readonly executionId: ExecutionId;
  readonly parentStreamId?: StreamTabId;
}

export type ResumeStateResolution =
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

export interface ResumeFailureDescription {
  readonly kind: 'lease-active' | 'unexpected';
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

/** Classify lease contention without making hosts recognize storage errors. */
export function describeResumeFailure(
  error: unknown,
): ResumeFailureDescription {
  return error instanceof ExecutionLeaseActiveError
    ? { kind: 'lease-active', message: error.message }
    : {
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
    session.followUps.release(claimedRecovery, 'recoverable');
  }
}

/** Resolve snapshot-backed metadata without collapsing read failure into absence. */
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
  readonly streamStatus: Pick<StreamStatusMachine, 'isActiveOrResuming'>;
  readonly isCancellationRequested?: () => boolean;
  resolveResumeState(streamId: StreamTabId): Promise<ResumeStateResolution>;
  reportResumeStateResolution?(
    streamId: StreamTabId,
    resolution: UnresolvedResumeState,
    message: string,
  ): void | Promise<void>;
  resumeToolUse(
    resume: ToolUseResumeData,
    recovery?: RecoveryContinuation,
  ): Promise<boolean>;
  executeWorkflow(
    config: AgentConfig,
    executionId: ExecutionId | undefined,
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
      await ports.reportResumeStateResolution?.(
        streamId,
        resolution,
        describeResumeStateResolution(resolution),
      );
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

    if (ports.streamStatus.isActiveOrResuming(streamId)) return false;

    if (resume.type === 'toolUse') {
      return await ports.resumeToolUse(resume, recovery);
    }

    await ports.executeWorkflow(
      resume.agentConfig,
      resume.executionId,
      resume.modelHandlerCompatibilityKey,
    );
    return true;
  } catch (error) {
    if (isCancellationRequested()) return false;
    await ports.reportFailure?.(streamId, error);
    return false;
  }
}
