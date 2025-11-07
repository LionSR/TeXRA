// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent coordination
import { getToolUseAgent } from '@agent/toolUse/ToolUseAgentRegistry';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - persistence helpers
import { ToolUseSessionPersistence } from './ToolUseSessionPersistence';
import { ToolUseFollowUpQueue } from './ToolUseFollowUpQueue';
import { ToolUseSnapshotCache } from './ToolUseSnapshotCache';
import type { ToolUseSessionSnapshot } from './ToolUseSnapshotTypes';

const CHANNEL = 'ToolUseSessionCoordinator';

export class ToolUseSessionCoordinator {
  static async handleFollowUp(
    streamId: StreamTabId,
    text: string,
  ): Promise<void> {
    const agent = getToolUseAgent(streamId);
    if (agent) {
      try {
        agent.appendFollowUp(text);
      } catch (error) {
        await vscode.window.showErrorMessage(
          `Failed to send follow-up: ${(error as Error).message}`,
        );
      }
      return;
    }

    if (ToolUseFollowUpQueue.isResuming(streamId)) {
      if (ToolUseFollowUpQueue.enqueue(streamId, text)) {
        console.log(
          `[${CHANNEL}] queued follow-up while stream ${streamId} is resuming`,
        );
        return;
      }
    }

    const pendingSnapshot = ToolUseSnapshotCache.getByStream(streamId);
    if (pendingSnapshot) {
      console.log(`[${CHANNEL}] resuming agent lazily for stream ${streamId}`);
      await this.resumeFromSnapshot(pendingSnapshot, text);
      return;
    }

    console.log(`[${CHANNEL}] no active session found for stream ${streamId}`);
    void vscode.window.showWarningMessage(
      'No active tool-use session found for this follow-up.',
    );
  }

  static async resumeFromSnapshot(
    snapshot: ToolUseSessionSnapshot,
    followUp?: string,
  ) {
    return ToolUseSessionPersistence.resumeFromSnapshot(snapshot, followUp);
  }
}
