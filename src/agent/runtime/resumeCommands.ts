import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';

import { resumeToolUseFromSnapshot } from './executeAgent';
import {
  detectPersistedToolUseWaitingSession,
  finishToolUseResume,
  prepareToolUseResume,
  restoreToolUseResumeFollowUps,
  type PersistedToolUseWaitingDetectionRequest,
  type ToolUseResumePreparation,
} from './toolUseResume';
import type { SessionHandle } from './SessionHandle';

export type RuntimeToolUseSessionSnapshot = ToolUseSessionSnapshot;
export type RuntimePersistedToolUseWaitingDetectionRequest =
  PersistedToolUseWaitingDetectionRequest;

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

/** Detect a persisted waiting tool-use session and mark the stream WAITING. */
export function detectRuntimePersistedToolUseWaitingSession(
  request: RuntimePersistedToolUseWaitingDetectionRequest,
): Promise<boolean> {
  return detectPersistedToolUseWaitingSession(request);
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
