import { Effect } from 'effect';

import {
  AgentCatalog,
  type WorkspaceAgentsController,
} from '@texra-ai/harness/host';
import { cliCommandDefaults } from './platform/cliConfig';
import type { SettingsStores } from '@texra-ai/harness/plugins';

/** The workspace agents controller's own snapshot shape — derived, never restated. */
type WorkspaceAgentsSnapshot = Effect.Success<
  ReturnType<WorkspaceAgentsController['snapshot']>
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
    const workspaceAgents = (yield* AgentCatalog).workspaceAgents(roots);
    return {
      ...(yield* workspaceAgents.snapshot()),
      defaultChatAgent: cliCommandDefaults(roots, 'chat').agent,
      agentKeys: (yield* workspaceAgents.getEnabledAgentKeys()) ?? 'all',
    } satisfies CliWorkspaceAgentsRecord;
  },
);

export function formatCliWorkspaceAgents(
  record: CliWorkspaceAgentsRecord,
): string {
  const lines = [
    `Workspace agents: ${record.selection.kind}`,
    `Default chat agent: ${record.defaultChatAgent ?? '(automatic)'}`,
    `Enabled agents: ${
      record.agentKeys === 'all'
        ? 'all'
        : record.agentKeys.join(', ') || '(none)'
    }`,
  ];
  if (record.unresolvedNames.length > 0) {
    lines.push(`Unavailable agents: ${record.unresolvedNames.join(', ')}`);
  }
  return lines.join('\n');
}
