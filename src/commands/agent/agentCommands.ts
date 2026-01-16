// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@common/constants/streamStatus';

export function registerAgentCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.stopAgent', (stream: string) => {
      getInterruptible(stream)?.interrupt();
      StreamStatusService.set(stream, STREAM_STATUS.STOPPED);
    }),
  );
}
