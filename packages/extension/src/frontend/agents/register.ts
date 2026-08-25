// Utilities for registering newly created agents

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { createWorkspaceAgentRosterController } from '@agent/index';
import { appSignals } from '@eventBus/AppSignals';
import { createLog } from '@logger/logUtils';
import type { AgentSource } from '@shared/schemas';

const log = createLog('AgentRegister');

export async function promptToAddAgentToConfig(
  agentName: string,
  source: AgentSource,
  category: 'workflow' | 'toolUse',
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
    // Reload the catalog first: the agent-creator just wrote this YAML, so
    // the registry still holds a cache without it and a listener that posted
    // now would render a roster missing the agent it was told about.
    await vscode.commands.executeCommand('texra.refreshAllOptions');
    // The write above rewrites the selection as `custom`, retiring any applied
    // team, so an open settings view needs the same notice `apply_team` sends.
    appSignals.emit('agentRosterChanged', undefined);
    vscode.window.showInformationMessage(`Agent "${agentName}" is now visible`);
  }
}
