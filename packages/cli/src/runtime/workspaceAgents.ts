import { Effect } from 'effect';

import { createWorkspaceAgentsController } from '@agent/index';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { WorkspaceAgentsSelection } from '@shared/schemas';
import { cliCommandDefaults } from './cliConfig';

/** The workspace agents controller's own snapshot shape — derived, never restated. */
type WorkspaceAgentsSnapshot = Effect.Success<
  ReturnType<ReturnType<typeof createWorkspaceAgentsController>['snapshot']>
>;

/** The agent list snapshot plus the two facts only the CLI resolves. The
 *  enabled keys are `'all'` when no custom list narrows them. */
export type CliWorkspaceAgentsRecord = WorkspaceAgentsSnapshot & {
  readonly defaultChatAgent?: string;
  readonly agentKeys: readonly string[] | 'all';
};

/**
 * The workspace agents as a program, run by the surface that shows it over the
 * roots that surface holds.
 */
export const readCliWorkspaceAgents = Effect.fn('readCliWorkspaceAgents')(
  function* (roots: SettingsStores) {
    const workspaceAgents = createWorkspaceAgentsController(roots);
    return {
      ...(yield* workspaceAgents.snapshot()),
      defaultChatAgent: cliCommandDefaults(roots, 'chat').agent,
      agentKeys: (yield* workspaceAgents.getEnabledAgentKeys()) ?? 'all',
    } satisfies CliWorkspaceAgentsRecord;
  },
);

function formatSelection(selection: WorkspaceAgentsSelection): string {
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

export function formatCliWorkspaceAgents(
  record: CliWorkspaceAgentsRecord,
): string {
  const lines = [
    `Workspace agents: ${formatSelection(record.selection)}`,
    `Effective agents: ${formatSelection(record.effectiveSelection)}`,
    `Default team: ${record.defaultTeamId ?? '(none)'}`,
    `Default chat agent: ${record.defaultChatAgent ?? '(automatic)'}`,
    `Enabled agents: ${
      record.agentKeys === 'all'
        ? 'all'
        : record.agentKeys.join(', ') || '(none)'
    }`,
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
