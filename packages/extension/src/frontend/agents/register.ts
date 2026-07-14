// Utilities for registering newly created agents

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { platform } from '@platform/platform';
import { AgentRosterController, getAgentsByCategory } from '@agent/index';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import * as logger from '@logger/logUtils';
import { parseAgentModePresets } from '@shared/schemas/agentPresets';

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
  const roster = new AgentRosterController({
    workspaceState: workspaceSM,
    globalState: platform().globalState,
    getAgents: getAgentsByCategory,
    getPresets: () =>
      parseAgentModePresets(
        workspaceSM.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
      ),
    fallbackTeamId: null,
  });
  const current = roster.getVisibleAgents(category).map((entry) => entry.name);

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
    await roster.setAgentEnabled({
      category,
      source: 'custom',
      name: agentName,
      enabled: true,
    });
    await vscode.commands.executeCommand('texra.refreshAllOptions');
    vscode.window.showInformationMessage(`Agent "${agentName}" is now visible`);
  }
}
