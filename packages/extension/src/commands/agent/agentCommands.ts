// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { executionRegistry } from '@agent/runtime/executionRegistry';
import { notifyFollowUpSent } from '@agent/followUp/ToolUseFollowUp';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

export function stopAgent(streamId: StreamTabId): void {
  executionRegistry.stopAgentStream(streamId, {
    detachActiveChildren: workspaceSM.get<boolean>(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    ),
    runtimeHost: extensionAgentRuntimeHost,
  });
}

export async function compactResponse(streamId: StreamTabId): Promise<void> {
  const result = executionRegistry.requestManualCompaction(streamId);
  switch (result.kind) {
    case 'no_active_tool_use':
      await vscode.window.showInformationMessage(
        'No active tool-use session found for this stream.',
      );
      return;
    case 'unsupported':
      await vscode.window.showInformationMessage(
        'Manual context compaction is not yet available for this model. Stay tuned!',
      );
      return;
    case 'requested':
      notifyFollowUpSent(result.streamId, result.runtimeHost);
      await vscode.window.showInformationMessage(
        'Context compaction requested. The agent will process it on the next model call.',
      );
      return;
  }
}
