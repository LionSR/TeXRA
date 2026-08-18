// Utilities for registering newly created agents

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { createWorkspaceAgentRosterController } from '@agent/index';
import { createLog } from '@logger/logUtils';
import type { AgentSource } from '@shared/schemas';

const log = createLog('AgentRegister');

export async function promptToAddAgentToConfig(
  agentName: string,
  source: AgentSource,
  category: 'workflow' | 'toolUse' = 'workflow',
): Promise<void> {
  const roster = createWorkspaceAgentRosterController();
  const current = roster.getVisibleAgents(category).map((entry) => entry.name);

  if (current.includes(agentName)) {
    log.debug(`Agent "${agentName}" already in configuration`);
    return;
  }

  const shouldAdd =
    (await vscode.window.showInformationMessage(
      `Agent "${agentName}" was created or modified. Show it in the agent dropdown?`,
      'Add Agent',
      'Cancel',
    )) === 'Add Agent';

  if (shouldAdd) {
    await roster.setAgentEnabled({
      category,
      source,
      name: agentName,
      enabled: true,
    });
    await vscode.commands.executeCommand('texra.refreshAllOptions');
    vscode.window.showInformationMessage(`Agent "${agentName}" is now visible`);
  }
}
