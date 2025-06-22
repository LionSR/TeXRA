// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - agent
import { BaseAgent } from '@agent/implementations/BaseAgent';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

const CHANNEL = 'AgentCommands';
logger.initialize(CHANNEL);

export function registerAgentCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.stopAgent', handleStopAgent),
  );
}

async function handleStopAgent(stream: string) {
  // Get the running agent instance
  const agent = BaseAgent.getRunningAgent(stream);
  if (agent) {
    // Interrupt the agent's execution
    agent.interrupt();
  }

  // Update the UI status
  const progressViewProvider = ProgressViewProvider.getInstance();
  if (progressViewProvider) {
    progressViewProvider.updateStreamStatus(stream, 'stopped');
  }
}

export const agentCommands = {
  handleStopAgent,
};
