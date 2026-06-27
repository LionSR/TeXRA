// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { requestManualCompaction } from '@agent/runtime/manualCompaction';
import { requestStopStream } from '@agent/runtime/streamControl';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

export function stopAgent(streamId: StreamTabId): void {
  requestStopStream({
    streamId,
    detachActiveChildren: workspaceSM.get<boolean>(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    ),
    runtimeHost: extensionAgentRuntimeHost,
  });
}

export async function compactResponse(streamId: StreamTabId): Promise<void> {
  const result = requestManualCompaction(streamId);
  switch (result.status) {
    case 'no_session':
      await vscode.window.showInformationMessage(
        'No active tool-use session found for this stream.',
      );
      return;
    case 'unsupported_model':
      await vscode.window.showInformationMessage(
        'Manual context compaction is not yet available for this model. Stay tuned!',
      );
      return;
    case 'requested':
      await vscode.window.showInformationMessage(
        'Context compaction requested. The agent will process it on the next model call.',
      );
      return;
  }
}
