// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { getToolUseAgent } from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseSessionManager } from '@agent/toolUse/ToolUseSessionManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - utilities
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';
import type { ResumeAgentResult } from './resumeCommand';

const CHANNEL = 'followUpCommand';
console.log(`[${CHANNEL}] command registered`);

export function registerFollowUpCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.sendFollowUp',
      async (payload: { stream: string; text: string }) => {
        const streamId = payload.stream as StreamTabId;
        const agent = getToolUseAgent(streamId);
        if (agent) {
          try {
            agent.appendFollowUp(payload.text);
          } catch (err) {
            await showLoggedErrorMessage(
              CHANNEL,
              'Failed to send follow-up',
              err,
            );
          }
          return;
        }

        if (
          ToolUseSessionManager.isResumingSession(streamId) &&
          ToolUseSessionManager.enqueueFollowUpWhileResuming(
            streamId,
            payload.text,
          )
        ) {
          console.log(
            `[${CHANNEL}] queued follow-up while stream ${payload.stream} is resuming`,
          );
          return;
        }

        const pendingSnapshot =
          ToolUseSessionManager.getSnapshotForStream(streamId);
        if (pendingSnapshot) {
          console.log(
            `[${CHANNEL}] resuming agent lazily for stream ${payload.stream}`,
          );
          ToolUseSessionManager.setResumingSession(streamId);
          try {
            const result = (await vscode.commands.executeCommand(
              'texra.resumeAgent',
              {
                snapshot: pendingSnapshot,
                followUp: payload.text,
              },
            )) as ResumeAgentResult | undefined;

            if (result?.success) {
              // Only consume the snapshot after successful resume
              ToolUseSessionManager.consumeSnapshotForStream(streamId);
            }
          } catch (err) {
            const lostFollowUps =
              ToolUseSessionManager.drainQueuedFollowUps(streamId);
            if (lostFollowUps.length > 0) {
              const followUpLabel =
                lostFollowUps.length === 1
                  ? 'follow-up was'
                  : 'follow-ups were';
              await vscode.window.showWarningMessage(
                `Resume failed. ${lostFollowUps.length} queued ${followUpLabel} lost.`,
              );
            }
            ToolUseSessionManager.clearResumingSession(streamId);
            await showLoggedErrorMessage(
              CHANNEL,
              'Failed to resume tool-use session for follow-up',
              err,
            );
          }
          return;
        }

        console.log(
          `[${CHANNEL}] no active session found for stream ${payload.stream}`,
        );
        void vscode.window.showWarningMessage(
          'No active tool-use session found for this follow-up.',
        );
      },
    ),
  );
}
