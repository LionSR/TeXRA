// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import * as logger from '@logger/logUtils';

const CHANNEL = 'AgentCommands';
logger.initialize(CHANNEL);

export function registerAgentCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.stopAgent', handleStopAgent),
  );
}

async function handleStopAgent(stream: string) {
  // Get the running execution from the unified registry
  // Handles both flow contexts and agent class instances
  const execution = getInterruptible(stream);
  if (execution) {
    execution.interrupt();
  }

  // Update the UI status
  StreamStatusService.set(stream, 'stopped');
}

export const agentCommands = {
  handleStopAgent,
};
