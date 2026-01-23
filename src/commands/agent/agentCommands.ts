// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@common/constants/streamStatus';

export function registerAgentCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.stopAgent',
      (streamId: StreamTabId) => {
        getInterruptible(streamId)?.interrupt();
        StreamStatusService.set(streamId, STREAM_STATUS.STOPPED);
      },
    ),
  );
}
