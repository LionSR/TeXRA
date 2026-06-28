import {
  retrieveSessionResumeData,
  type SessionResumeData,
} from '@agent/runtime/SessionResumeRetrieval';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import type { TaskState } from '@agent/core/execution/TaskState';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { toErrorMessage } from '@common/errors';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

import { resumeToolUseFromSnapshot } from './executeAgent';
import {
  buildRuntimeTaskStateFromConfig,
  isRuntimeToolUseTaskState,
  type RuntimeAgentConfig,
} from './executionRequests';
import { getStreamTabId } from './streamTab';
import { publishRuntimeQueuedFollowUps } from './queuedFollowUps';
import { StreamStatusService } from './StreamStatusService';
import type { SessionHandle } from './SessionHandle';

export type RuntimeToolUseSessionSnapshot = ToolUseSessionSnapshot;
export type RuntimeSessionResumeData = SessionResumeData;

export interface RuntimeSessionResumeDataRequest {
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly taskState: TaskState;
}

export interface RuntimeToolUseResumeData {
  readonly snapshot: RuntimeToolUseSessionSnapshot;
  readonly streamId: StreamTabId;
  readonly config: RuntimeAgentConfig;
}

export interface RuntimeToolUseResumeDataRequest {
  readonly executionId: ExecutionId;
  readonly config: RuntimeAgentConfig;
}

export type RuntimeSessionResumeDataResult =
  | {
      readonly status: 'resumable';
      readonly data: RuntimeSessionResumeData;
    }
  | {
      readonly status: 'missing';
    }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      readonly message: string;
    };

export type RuntimeToolUseResumeDataResult =
  | {
      readonly status: 'resumable';
      readonly data: RuntimeToolUseResumeData;
    }
  | {
      readonly status: 'not_tool_use';
    }
  | {
      readonly status: 'not_resumable';
      readonly streamId: StreamTabId;
    }
  | {
      readonly status: 'failed';
      readonly streamId: StreamTabId;
      readonly error: unknown;
      readonly message: string;
    };

export interface RuntimeToolUseSnapshotResumeRequest {
  readonly snapshot: RuntimeToolUseSessionSnapshot;
  readonly runtimeHost: AgentRuntimeHost;
  readonly followUp?: string;
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Hide tools unavailable because the current host/runtime cannot support them. */
  readonly runtimeUnavailableTools?: readonly string[];
  /** Session owning this run's coordination state. Defaults to the process session. */
  readonly session?: SessionHandle;
}

export interface RuntimeWorkflowResumeRequest {
  readonly streamId: StreamTabId;
  readonly runtimeHost: AgentRuntimeHost;
  readonly run: () => Promise<void>;
}

interface ToolUseResumePreparationRequest {
  readonly streamId: StreamTabId;
  readonly runtimeHost: AgentRuntimeHost;
  readonly followUp?: string;
}

interface ToolUseResumePreparation {
  readonly streamId: StreamTabId;
  readonly followUps: readonly FollowUpQueueInput[];
}

interface ToolUseResumeFollowUpRestoreRequest extends ToolUseResumePreparation {
  readonly runtimeHost: AgentRuntimeHost;
}

interface ToolUseResumeFinishRequest {
  readonly streamId: StreamTabId;
  readonly runtimeHost: AgentRuntimeHost;
}

function prepareToolUseResume({
  streamId,
  runtimeHost,
  followUp,
}: ToolUseResumePreparationRequest): ToolUseResumePreparation | null {
  if (StreamStatusService.isActiveOrResuming(streamId)) {
    return null;
  }

  ToolUseFollowUpQueue.acquire(streamId);
  StreamStatusService.set(streamId, STREAM_STATUS.RESUMING, {
    runtimeHost,
  });

  const explicitFollowUps: readonly FollowUpQueueInput[] =
    followUp !== undefined ? [{ text: followUp, origin: 'user' }] : [];
  const followUps = [
    ...explicitFollowUps,
    ...ToolUseFollowUpQueue.drainItems(streamId),
  ];
  publishRuntimeQueuedFollowUps(runtimeHost, streamId);

  return { streamId, followUps };
}

function restoreToolUseResumeFollowUps({
  streamId,
  runtimeHost,
  followUps,
}: ToolUseResumeFollowUpRestoreRequest): void {
  for (const item of followUps) {
    ToolUseFollowUpQueue.enqueue(streamId, item, { force: true });
  }
  if (followUps.length > 0) {
    publishRuntimeQueuedFollowUps(runtimeHost, streamId);
  }
}

function finishToolUseResume({
  streamId,
  runtimeHost,
}: ToolUseResumeFinishRequest): void {
  if (StreamStatusService.get(streamId) === STREAM_STATUS.RESUMING) {
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
      runtimeHost,
    });
  }
}

/**
 * Retrieve persisted resume data and classify storage failures separately from
 * valid "nothing to resume" states.
 */
export async function readRuntimeSessionResumeData({
  streamId,
  executionId,
  taskState,
}: RuntimeSessionResumeDataRequest): Promise<RuntimeSessionResumeDataResult> {
  try {
    const data = await retrieveSessionResumeData(
      streamId,
      executionId,
      taskState,
    );
    if (!data) return { status: 'missing' };
    return { status: 'resumable', data };
  } catch (error) {
    return {
      status: 'failed',
      error,
      message: toErrorMessage(error),
    };
  }
}

/**
 * Resolve resumable tool-use data from the persisted execution config.
 *
 * This keeps stream-id derivation, task-state projection, and resume-data
 * interpretation in one runtime operation; hosts only decide how to present the
 * classified result.
 */
export async function readRuntimeToolUseResumeDataForConfig({
  executionId,
  config,
}: RuntimeToolUseResumeDataRequest): Promise<RuntimeToolUseResumeDataResult> {
  const taskState = buildRuntimeTaskStateFromConfig(config);
  if (!isRuntimeToolUseTaskState(taskState)) {
    return { status: 'not_tool_use' };
  }

  const streamId = getStreamTabId(config.agent, config.model, {
    executionId,
  });
  const resume = await readRuntimeSessionResumeData({
    streamId,
    executionId,
    taskState,
  });

  if (resume.status === 'failed') {
    return {
      status: 'failed',
      streamId,
      error: resume.error,
      message: resume.message,
    };
  }
  if (resume.status !== 'resumable' || resume.data.type !== 'toolUse') {
    return { status: 'not_resumable', streamId };
  }

  return {
    status: 'resumable',
    data: {
      snapshot: resume.data.snapshot,
      streamId,
      config: resume.data.snapshot.agentConfig,
    },
  };
}

/**
 * Resume a persisted workflow by delegating stream ownership to the normal run
 * lifecycle. The launch callback calls `runAgent`, which must be free to claim
 * the stream itself; this wrapper only repairs a host path that leaves the
 * stream in RESUMING after a failed launch.
 */
export async function requestRuntimeWorkflowResume({
  streamId,
  runtimeHost,
  run,
}: RuntimeWorkflowResumeRequest): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (StreamStatusService.get(streamId) === STREAM_STATUS.RESUMING) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        runtimeHost,
      });
    }
    throw error;
  }
}

/**
 * Resume a persisted tool-use snapshot.
 *
 * Returns false when another runtime consumer already owns the stream. Throws
 * after restoring queued follow-ups when the resume attempt itself fails.
 */
export async function requestRuntimeToolUseSnapshotResume({
  snapshot,
  runtimeHost,
  followUp,
  approvalPromptsUnavailable,
  runtimeUnavailableTools,
  session,
}: RuntimeToolUseSnapshotResumeRequest): Promise<boolean> {
  const { streamId } = snapshot;
  let preparation: ToolUseResumePreparation | null = null;

  try {
    preparation = prepareToolUseResume({
      streamId,
      runtimeHost,
      followUp,
    });
    if (!preparation) return false;
    const preparedResume = preparation;

    await resumeToolUseFromSnapshot(snapshot, runtimeHost, {
      approvalPromptsUnavailable,
      runtimeUnavailableTools,
      session,
      setupSession: (toolUseSession) => {
        for (const item of preparedResume.followUps) {
          toolUseSession.appendFollowUp(item);
        }
      },
    });

    return true;
  } catch (error) {
    if (preparation) {
      restoreToolUseResumeFollowUps({ ...preparation, runtimeHost });
    }
    throw error;
  } finally {
    if (preparation) {
      finishToolUseResume({ streamId, runtimeHost });
    }
  }
}
