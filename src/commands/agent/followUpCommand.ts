// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { getToolUseAgent } from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseSessionManager } from '@agent/toolUse/ToolUseSessionManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - utilities
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

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

        const pendingSnapshot =
          ToolUseSessionManager.consumeSnapshotForStream(streamId);
        if (pendingSnapshot) {
          console.log(
            `[${CHANNEL}] resuming agent lazily for stream ${payload.stream}`,
          );
          try {
            await vscode.commands.executeCommand('texra.resumeAgent', {
              snapshot: pendingSnapshot,
              followUp: payload.text,
            });
          } catch (err) {
            ToolUseSessionManager.clearResumingSession(streamId);
            await showLoggedErrorMessage(
              CHANNEL,
              'Failed to resume tool-use session for follow-up',
              err,
            );
          }
          return;
        }

        if (
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
