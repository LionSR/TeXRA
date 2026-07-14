import { platform } from '@platform/platform';
import {
  AgentRosterController,
  getAgentsByCategory,
  loadAgents,
  resolveAgentKey,
} from '@agent/index';
import { agentKeyOf } from '@shared/schemas/agent';
import { parseAgentModePresets } from '@shared/schemas/agentPresets';
import type { AgentRosterSelection } from '@shared/schemas/agentRoster';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { loadWorkspaceCliConfig, resolveConfiguredAgent } from './cliConfig';

export interface CliAgentRosterRecord {
  readonly selection: AgentRosterSelection;
  readonly effectiveSelection: Exclude<
    AgentRosterSelection,
    { readonly kind: 'inherit' }
  >;
  readonly defaultTeamId?: string;
  readonly defaultChatAgent?: string;
  readonly workflowAgentKeys: readonly string[];
  readonly toolUseAgentKeys: readonly string[];
  readonly unresolvedNames: readonly string[];
}

/** Construct the CLI's single roster controller over the active host stores. */
export function cliAgentRosterController(): AgentRosterController {
  const { workspaceState, globalState } = platform();
  return new AgentRosterController({
    workspaceState,
    globalState,
    getAgents: getAgentsByCategory,
    getPresets: () =>
      parseAgentModePresets(
        workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
      ),
    resolveIdentifier: (category, identifier) =>
      resolveAgentKey(identifier, category),
    fallbackTeamId: null,
  });
}

export async function readCliAgentRoster(): Promise<CliAgentRosterRecord> {
  await loadAgents({ includeRemote: false });
  const snapshot = cliAgentRosterController().snapshot();
  const cwd = platform().workspace.getWorkspacePath();
  const config = cwd ? await loadWorkspaceCliConfig(cwd) : undefined;
  return {
    selection: snapshot.selection,
    effectiveSelection: snapshot.effectiveSelection,
    defaultTeamId: snapshot.defaultTeamId,
    defaultChatAgent: resolveConfiguredAgent(config?.values, 'chat'),
    workflowAgentKeys: snapshot.workflowAgents.map(agentKeyOf),
    toolUseAgentKeys: snapshot.toolUseAgents.map(agentKeyOf),
    unresolvedNames: snapshot.unresolvedNames,
  };
}

function formatSelection(selection: AgentRosterSelection): string {
  switch (selection.kind) {
    case 'inherit':
      return 'inherit';
    case 'all':
      return 'all';
    case 'team':
      return `team:${selection.teamId}`;
    case 'custom':
      return 'custom';
  }
}

export function formatCliAgentRoster(record: CliAgentRosterRecord): string {
  const lines = [
    `Workspace roster: ${formatSelection(record.selection)}`,
    `Effective roster: ${formatSelection(record.effectiveSelection)}`,
    `Default team: ${record.defaultTeamId ?? '(none)'}`,
    `Default chat agent: ${record.defaultChatAgent ?? '(automatic)'}`,
    `Workflow agents: ${record.workflowAgentKeys.join(', ') || '(none)'}`,
    `Tool-use agents: ${record.toolUseAgentKeys.join(', ') || '(none)'}`,
  ];
  if (record.unresolvedNames.length > 0) {
    lines.push(`Unavailable members: ${record.unresolvedNames.join(', ')}`);
  }
  return lines.join('\n');
}
