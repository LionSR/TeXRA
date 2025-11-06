// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent persistence
import {
  ToolUseSessionPersistence,
  type ToolUseSessionSnapshot,
  type ResumeAgentResult,
} from '@agent/toolUse/ToolUseSessionPersistence';
import { ToolUseResumeQueue } from '@agent/toolUse/ToolUseResumeQueue';
import { getToolUseAgent } from '@agent/toolUse/ToolUseAgentRegistry';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - utilities
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

const CHANNEL = 'toolUseFollowUpCoordinator';

export async function sendFollowUp(
  streamId: StreamTabId,
  text: string,
): Promise<void> {
  const agent = getToolUseAgent(streamId);
  if (agent) {
    try {
      agent.appendFollowUp(text);
    } catch (err) {
      await showLoggedErrorMessage(CHANNEL, 'Failed to send follow-up', err);
    }
    return;
  }

  if (ToolUseResumeQueue.isResumingSession(streamId)) {
    if (ToolUseResumeQueue.enqueueFollowUpWhileResuming(streamId, text)) {
      console.log(
        `[${CHANNEL}] queued follow-up while stream ${streamId} is resuming`,
      );
      return;
    }
  }

  const pendingSnapshot = ToolUseResumeQueue.getSnapshotForStream(streamId);
  if (pendingSnapshot) {
    console.log(`[${CHANNEL}] resuming agent lazily for stream ${streamId}`);
    await resumeFromSnapshot(pendingSnapshot, text);
    return;
  }

  console.log(`[${CHANNEL}] no active session found for stream ${streamId}`);
  void vscode.window.showWarningMessage(
    'No active tool-use session found for this follow-up.',
  );
}

export async function resumeFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  followUp?: string,
): Promise<ResumeAgentResult> {
  if (!snapshot) {
    return { success: false };
  }

  return await ToolUseSessionPersistence.resumeFromSnapshot(snapshot, followUp);
}

export type { ResumeAgentResult } from '@agent/toolUse/ToolUseSessionPersistence';
