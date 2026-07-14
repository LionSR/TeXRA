import { platform } from '@platform/platform';
import {
  AgentRosterController,
  getAgentsByCategory,
  getRosterAgent,
  loadAgents,
} from '@agent/index';
import { parseAgentModePresets } from '@shared/schemas/agentPresets';
import type {
  AgentRosterCategorySelection,
  AgentRosterSelection,
} from '@shared/schemas/agentRoster';
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
  readonly workflowAgentKeys: AgentRosterCategorySelection;
  readonly toolUseAgentKeys: AgentRosterCategorySelection;
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
    resolveAgent: getRosterAgent,
    fallbackTeamId: null,
  });
}

export async function readCliAgentRoster(): Promise<CliAgentRosterRecord> {
  await loadAgents({ includeRemote: false });
  const roster = cliAgentRosterController();
  const snapshot = roster.snapshot();
  const cwd = platform().workspace.getWorkspacePath();
  const config = cwd ? await loadWorkspaceCliConfig(cwd) : undefined;
  return {
    selection: snapshot.selection,
    effectiveSelection: snapshot.effectiveSelection,
    defaultTeamId: snapshot.defaultTeamId,
    defaultChatAgent: resolveConfiguredAgent(config?.values, 'chat'),
    workflowAgentKeys: roster.getEnabledAgentKeys('workflow') ?? 'all',
    toolUseAgentKeys: roster.getEnabledAgentKeys('toolUse') ?? 'all',
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
  const formatCategory = (selection: AgentRosterCategorySelection): string =>
    selection === 'all' ? 'all' : selection.join(', ') || '(none)';
  const lines = [
    `Workspace roster: ${formatSelection(record.selection)}`,
    `Effective roster: ${formatSelection(record.effectiveSelection)}`,
    `Default team: ${record.defaultTeamId ?? '(none)'}`,
    `Default chat agent: ${record.defaultChatAgent ?? '(automatic)'}`,
    `Workflow agents: ${formatCategory(record.workflowAgentKeys)}`,
    `Tool-use agents: ${formatCategory(record.toolUseAgentKeys)}`,
  ];
  if (record.unresolvedNames.length > 0) {
    lines.push(`Unavailable members: ${record.unresolvedNames.join(', ')}`);
  }
  return lines.join('\n');
}
