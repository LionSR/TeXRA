// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { defaultSession, detachSubagentsOnStop } from '@agent/runtime';
import { notifyFollowUpSent } from '@agent/followUp/ToolUseFollowUp';
import type { StreamTabId } from '@shared/schemas';

export function stopAgent(streamId: StreamTabId): void {
  defaultSession().executions.stopAgentStream(streamId, {
    detachActiveChildren: detachSubagentsOnStop(),
  });
}

export async function compactResponse(streamId: StreamTabId): Promise<void> {
  const result = defaultSession().executions.requestManualCompaction(streamId);
  switch (result.kind) {
    case 'no_active_tool_use':
      await vscode.window.showInformationMessage(
        'No active tool-use session found for this stream.',
      );
      return;
    case 'unsupported':
      await vscode.window.showInformationMessage(
        'Manual context compaction is not available for this model.',
      );
      return;
    case 'requested':
      notifyFollowUpSent(result.streamId, result.session);
      await vscode.window.showInformationMessage(
        'Context compaction requested. The agent will process it on the next model call.',
      );
      return;
  }
}
