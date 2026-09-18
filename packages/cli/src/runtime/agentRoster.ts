import { Effect } from 'effect';

import { createWorkspaceAgentRosterController, loadAgents } from '@agent/index';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  byCategory,
  type AgentRosterCategorySelection,
  type AgentRosterSelection,
  type ByCategory,
} from '@shared/schemas';
import { cliCommandDefaults } from './cliConfig';

/** The roster controller's own snapshot shape — derived, never restated. */
type AgentRosterSnapshot = ReturnType<
  ReturnType<typeof createWorkspaceAgentRosterController>['snapshot']
>;

/** The roster snapshot plus the two facts only the CLI resolves. */
export type CliAgentRosterRecord = AgentRosterSnapshot & {
  readonly defaultChatAgent?: string;
  readonly agentKeys: ByCategory<AgentRosterCategorySelection>;
};

/**
 * The workspace roster as a program, run by the surface that shows it over the
 * roots that surface holds.
 */
export const readCliAgentRoster = Effect.fn('readCliAgentRoster')(function* (
  roots: SettingsStores,
) {
  yield* loadAgents({ includeRemote: false });
  const roster = createWorkspaceAgentRosterController(roots);
  return {
    ...roster.snapshot(),
    defaultChatAgent: cliCommandDefaults(roots, 'chat').agent,
    agentKeys: byCategory(
      (category) => roster.getEnabledAgentKeys(category) ?? 'all',
    ),
  } satisfies CliAgentRosterRecord;
});

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
