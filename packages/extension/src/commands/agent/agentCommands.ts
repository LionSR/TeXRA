// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  detachActiveChildren,
  interruptActiveChildren,
} from '@agent/runtime/executionRegistry';
import { notifyFollowUpSent } from '@agent/toolUse/ToolUseFollowUp';
import {
  getInterruptible,
  getToolUseFlowContext,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { STREAM_STATUS } from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';

export function stopAgent(streamId: StreamTabId): void {
  if (
    workspaceSM.get<boolean>(WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP, false)
  ) {
    detachActiveChildren(streamId, extensionAgentRuntimeHost);
  } else {
    interruptActiveChildren(streamId);
  }
  getInterruptible(streamId)?.interrupt();
  StreamStatusService.set(streamId, STREAM_STATUS.STOPPED, {
    runtimeHost: extensionAgentRuntimeHost,
  });
}

export async function compactResponse(streamId: StreamTabId): Promise<void> {
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

  flowContext.requestImmediateCompaction();
  notifyFollowUpSent(streamId, flowContext.runtimeHost);
  await vscode.window.showInformationMessage(
    'Context compaction requested. The agent will process it on the next model call.',
  );
}
