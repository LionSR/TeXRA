// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { requestManualCompaction } from '@agent/runtime/manualCompaction';
import { requestRuntimeStreamStop } from '@agent/runtime/streamControl';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

export type StopAgentCommandArgs =
  | StreamTabId
  | {
      readonly streamId: StreamTabId;
      readonly clearRetryRequest?: boolean | null;
    };

export function stopAgent(args: StopAgentCommandArgs): void {
  const streamId = typeof args === 'string' ? args : args.streamId;
  requestRuntimeStreamStop({
    streamId,
    clearRetryRequest:
      typeof args === 'string' ? undefined : (args.clearRetryRequest ?? false),
    detachActiveChildren: workspaceSM.get<boolean>(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    ),
    runtimeHost: extensionAgentRuntimeHost,
  });
}

export async function compactResponse(streamId: StreamTabId): Promise<void> {
  const result = requestManualCompaction(streamId);
  await vscode.window.showInformationMessage(result.message);
}
