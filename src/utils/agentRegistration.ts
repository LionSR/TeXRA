// Utilities for registering newly created agents

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import * as logger from '../logger/logUtils';

const CHANNEL = 'AgentRegister';
logger.initialize(CHANNEL);

/**
 * Prompt the user to add a newly created agent to the `texra.agents` setting.
 * If the agent already exists in the configuration the function silently
 * returns.
 */
export async function promptToAddAgentToConfig(
  agentName: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const current = config.get<string[]>('texra.agents', []);

  if (current.includes(agentName)) {
    logger.debug(CHANNEL, `Agent "${agentName}" already in configuration`);
    return;
  }

  const addButton = 'Add Agent';
  const choice = await vscode.window.showInformationMessage(
    `Agent "${agentName}" was created. Add it to 'texra.agents'?`,
    addButton,
    'Cancel',
  );

  if (choice === addButton) {
    current.push(agentName);
    await config.update(
      'texra.agents',
      current,
      vscode.ConfigurationTarget.Workspace,
    );
    vscode.window.showInformationMessage(
      `Added "${agentName}" to texra.agents`,
    );
  }
}
