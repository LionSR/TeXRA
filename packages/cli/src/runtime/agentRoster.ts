import {
  createWorkspaceAgentRosterController,
  loadAgents,
} from '@agent/index';
import { platform } from '@platform/platform';
import { byCategory, type ByCategory } from '@shared/schemas';
import type {
  AgentRosterCategorySelection,
  AgentRosterSelection,
} from '@shared/schemas/agentRoster';
import { loadWorkspaceCliConfig, resolveConfiguredAgent } from './cliConfig';

export interface CliAgentRosterRecord {
  readonly selection: AgentRosterSelection;
  readonly effectiveSelection: Exclude<
    AgentRosterSelection,
    { readonly kind: 'inherit' }
  >;
  readonly defaultTeamId?: string;
  readonly missingTeamId?: string;
  readonly defaultChatAgent?: string;
  readonly agentKeys: ByCategory<AgentRosterCategorySelection>;
  readonly unresolvedNames: readonly string[];
}

export async function readCliAgentRoster(): Promise<CliAgentRosterRecord> {
  await loadAgents({ includeRemote: false });
  const roster = createWorkspaceAgentRosterController();
  const snapshot = roster.snapshot();
  const cwd = platform().workspace.getWorkspacePath();
  const config = cwd ? await loadWorkspaceCliConfig(cwd) : undefined;
  return {
    selection: snapshot.selection,
    effectiveSelection: snapshot.effectiveSelection,
    defaultTeamId: snapshot.defaultTeamId,
    missingTeamId: snapshot.missingTeamId,
    defaultChatAgent: resolveConfiguredAgent(config?.values, 'chat'),
    agentKeys: byCategory(
      (category) => roster.getEnabledAgentKeys(category) ?? 'all',
    ),
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
    `Workflow agents: ${formatCategory(record.agentKeys.workflow)}`,
    `Tool-use agents: ${formatCategory(record.agentKeys.toolUse)}`,
  ];
  if (record.unresolvedNames.length > 0) {
    lines.push(`Unavailable members: ${record.unresolvedNames.join(', ')}`);
  }
  if (record.missingTeamId) {
    lines.push(
      `Unavailable team: ${record.missingTeamId}; showing all agents instead`,
    );
  }
  return lines.join('\n');
}
