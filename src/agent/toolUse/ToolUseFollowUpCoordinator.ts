// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent coordination
import { getToolUseAgent } from '@agent/toolUse/ToolUseAgentRegistry';
// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - persistence
import { ToolUseSessionManager } from './ToolUseSessionManager';
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueue';
import {
  ToolUseSessionPersistence,
  type ResumeAgentResult,
  type ToolUseSessionSnapshot,
} from './ToolUseSessionPersistence';

const logger = new AgentLogger('ToolUseFollowUpCoordinator');

export async function sendFollowUp(
  streamId: StreamTabId,
  text: string,
): Promise<void> {
  const agent = getToolUseAgent(streamId);
  if (agent) {
    try {
      agent.appendFollowUp(text);
    } catch (error) {
      logger.error('Failed to send follow-up to active agent.', {
        data: error,
      });
      await vscode.window.showErrorMessage(
        `Failed to send follow-up: ${(error as Error).message}`,
      );
    }
    return;
  }

  if (ToolUseFollowUpQueue.isResuming(streamId)) {
    if (ToolUseFollowUpQueue.enqueue(streamId, text)) {
      logger.debug(`Queued follow-up while stream ${streamId} is resuming.`);
      return;
    }
  }

  const pendingSnapshot = ToolUseSessionManager.getByStream(streamId);
  if (pendingSnapshot) {
    logger.debug(`Resuming agent lazily for stream ${streamId}.`);
    await ToolUseSessionPersistence.resumeFromSnapshot(pendingSnapshot, text);
    return;
  }

  logger.debug(`No active session found for follow-up on stream ${streamId}.`);
  void vscode.window.showWarningMessage(
    'No active tool-use session found for this follow-up.',
  );
}

export function resumeFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  followUp?: string,
): Promise<ResumeAgentResult> {
  return ToolUseSessionPersistence.resumeFromSnapshot(snapshot, followUp);
}

export type { ResumeAgentResult } from './ToolUseSessionPersistence';
