// Utilities for registering newly created agents

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { createWorkspaceAgentRosterController, refresh } from '@agent/index';
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
  const alreadyVisible = roster
    .getVisibleAgents(category)
    .some((entry) => entry.name === agentName);

  if (alreadyVisible) {
    log.debug(`Agent "${agentName}" already in configuration`);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Agent "${agentName}" was created or modified. Show it in the agent dropdown?`,
    'Add Agent',
    'Cancel',
  );
  if (choice !== 'Add Agent') return;

  await roster.setAgentEnabled({
    category,
    source,
    name: agentName,
    enabled: true,
  });
  // Reload the catalog here rather than leaning on `refreshAllOptions`:
  // that command returns early when the main webview is closed, so the
  // reload it performs is conditional on an unrelated view being open. The
  // agent-creator just wrote this YAML, so a listener posting against the
  // stale cache would render a roster missing the agent it was told about.
  await refresh();
  // The write above rewrites the selection as `custom`, retiring any applied
  // team, so an open settings view needs the same notice `apply_team` sends.
  appSignals.emit('agentRosterChanged', undefined);
  await vscode.commands.executeCommand('texra.refreshAllOptions', {
    agentCatalogAlreadyFresh: true,
  });
  vscode.window.showInformationMessage(`Agent "${agentName}" is now visible`);
}
