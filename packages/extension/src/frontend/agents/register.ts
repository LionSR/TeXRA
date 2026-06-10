// Utilities for registering newly created agents

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import * as logger from '@logger/logUtils';

const CHANNEL = 'AgentRegister';
logger.initialize(CHANNEL);

export type AgentRegistrationSkipReason = 'alreadyRegistered';

export function getAgentRegistrationSkipReason(
  agentName: string,
  configuredAgents: string[],
): AgentRegistrationSkipReason | undefined {
  if (configuredAgents.includes(agentName)) {
    return 'alreadyRegistered';
  }
  return undefined;
}

export async function promptToAddAgentToConfig(
  agentName: string,
  autoAdd = false,
  category: 'workflow' | 'toolUse' = 'workflow',
): Promise<void> {
  const stateKey =
    category === 'toolUse'
      ? WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS
      : WorkspaceStateKey.ENABLED_AGENTS;
  const current = workspaceSM.get<string[]>(stateKey, []);

  const skipReason = getAgentRegistrationSkipReason(agentName, current);
  if (skipReason) {
    logger.debug(CHANNEL, `Agent "${agentName}" already in configuration`);
    return;
  }

  const shouldAdd =
    autoAdd ||
    (await vscode.window.showInformationMessage(
      `Agent "${agentName}" was created or modified. Show it in the agent dropdown?`,
      'Add Agent',
      'Cancel',
    )) === 'Add Agent';

  if (shouldAdd) {
    current.push(agentName);
    await workspaceSM.update(stateKey, current);
    await vscode.commands.executeCommand('texra.refreshAllOptions');
    vscode.window.showInformationMessage(`Agent "${agentName}" is now visible`);
  }
}
