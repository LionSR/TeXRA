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
  const flowContext = executionRegistry.getToolUseFlowContext(streamId);
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

  flowContext.requestImmediateCompaction();
  notifyFollowUpSent(streamId, flowContext.runtimeHost);
  await vscode.window.showInformationMessage(
    'Context compaction requested. The agent will process it on the next model call.',
  );
}
