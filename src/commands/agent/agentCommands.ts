// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import {
  getInterruptible,
  getToolUseFlowContext,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { detachActiveChildren } from '@agent/runtime/executionRegistry';
import { STREAM_STATUS } from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';

export function registerAgentCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.stopAgent',
      (streamId: StreamTabId) => {
        detachActiveChildren(streamId);
        getInterruptible(streamId)?.interrupt();
        StreamStatusService.set(streamId, STREAM_STATUS.STOPPED);
      },
    ),
    vscode.commands.registerCommand(
      'texra.compactResponse',
      async (streamId: StreamTabId) => {
        const flowContext = getToolUseFlowContext(streamId);
        if (!flowContext) {
          await vscode.window.showInformationMessage(
            'No active tool-use session found for this stream.',
          );
          return;
        }

        if (!flowContext.modelHandler.supportsManualCompaction) {
          await vscode.window.showInformationMessage(
            'Manual context compaction is not yet available for this model. Stay tuned!',
          );
          return;
        }

        flowContext.modelHandler.requestCompaction();
        await vscode.window.showInformationMessage(
          'Context compaction requested. The conversation will be compacted on the next API call.',
        );
      },
    ),
  );
}
