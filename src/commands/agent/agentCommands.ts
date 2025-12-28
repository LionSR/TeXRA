// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { BaseAgent } from '@agent/implementations/BaseAgent';
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
  // Get the running execution (agent or flow context)
  const execution = BaseAgent.getRunningAgent(stream) ?? getInterruptible(stream);
  if (execution) {
    // Interrupt the execution
    execution.interrupt();
  }

  // Update the UI status
  StreamStatusService.set(stream, 'stopped');
}

export const agentCommands = {
  handleStopAgent,
};
