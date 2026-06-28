// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import {
  requestRuntimeFollowUp,
  type RuntimeFollowUpNotice,
} from '@agent/runtime/followUpCommands';
import { registerCommands } from '@commands/_shared/registerCommands';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { StreamTabId } from '@shared/schemas';

async function showFollowUpNotice(
  notice: RuntimeFollowUpNotice | undefined,
): Promise<void> {
  if (!notice) return;
  switch (notice.severity) {
    case 'information':
      await vscode.window.showInformationMessage(notice.message);
      return;
    case 'warning':
      await vscode.window.showWarningMessage(notice.message);
      return;
  }
}

export function registerFollowUpCommand(context: vscode.ExtensionContext) {
  registerCommands(context, [
    {
      id: 'texra.sendFollowUp',
      handler: async (payload: {
        stream: StreamTabId;
        text: string;
        mediaFiles?: string[];
      }) => {
        const { stream: streamId, text, mediaFiles } = payload;
        const executionId =
          ProgressViewProvider.getInstance()?.state?.snapshots.getExecutionId(
            streamId,
          );

        const result = await requestRuntimeFollowUp({
          streamId,
          text,
          mediaFiles,
          runtimeHost: extensionAgentRuntimeHost,
          ...(executionId !== undefined
            ? { persistedWaitingExecutionId: executionId }
            : {}),
          wakeQueuedStream: true,
        });
        await showFollowUpNotice(result.notice);
      },
    },
  ]);
}
