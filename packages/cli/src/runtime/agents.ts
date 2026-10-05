import { Effect } from 'effect';

import {
  getAgent,
  getCatalogAgents,
  getVisibleAgents,
  resolveAgentForLaunch,
  type AgentEntry,
  type WorkspaceAgentsStores,
} from '@agent/index';
import { agentKeyOf } from '@shared/schemas';
import { formatResultCount } from '@utils/text/stringUtils';

import { CliUsageError } from './cliContext';

export interface CliAgentListOptions {
  readonly includeHidden?: boolean;
  /** Only the agents that are also document tasks. */
  readonly tasks?: boolean;
}

interface CliAgentListResult {
  readonly agents: readonly AgentEntry[];
  readonly hiddenCount: number;
}

const AGENT_LOOKUP_HINT =
  'Use `texra agents list` for visible starter agents, `texra agents list --all` for every agent, or pass a known launchable agent name from a team.';
const TEAM_LOOKUP_HINT =
  'Use `texra team list` for available teams, then run `texra team show <team>` to check a team before launch.';

export const AGENT_NAME_DESCRIPTION =
  'Agent name from `texra agents list` or `texra agents list --all`';

export const LAUNCHABLE_AGENT_NAME_DESCRIPTION =
  'Agent name from `texra agents list --all`';

export function missingAgentMessage(name: string): string {
  return `Agent not found: ${name}. ${AGENT_LOOKUP_HINT}`;
}

export function missingTeamMessage(name: string): string {
  return `Team not found: ${name}. ${TEAM_LOOKUP_HINT}`;
}

/**
 * Resolve the agent a launch names, through the launch resolver, so the
 * check lands on the exact entry the launch loads. A name nothing resolves is
 * a usage error.
 */
export function resolveCliRunAgent(
  stores: WorkspaceAgentsStores,
  name: string,
) {
  return Effect.flatMap(resolveAgentForLaunch(stores, name), (agent) =>
    agent === undefined
      ? Effect.fail(new CliUsageError(missingAgentMessage(name)))
      : Effect.succeed(agent),
  );
}

/** Resolve the agent a display command names, by the catalog's rule. */
export function resolveCliAgent(identifier: string): AgentEntry | undefined {
  return getAgent(identifier);
}

export function loadCliAgentList(
  stores: WorkspaceAgentsStores,
  options: CliAgentListOptions = {},
) {
  const includeHidden = options.includeHidden === true;
  return Effect.gen(function* () {
    const agents = yield* collectCliAgents(
      stores,
      includeHidden ? 'all' : 'visible',
      options.tasks === true,
    );
    const hiddenCount = includeHidden
      ? 0
      : (yield* collectCliAgents(stores, 'all', options.tasks === true))
          .length - agents.length;

    return { agents, hiddenCount } satisfies CliAgentListResult;
  });
}

export function formatCliAgentList(
  agents: readonly AgentEntry[],
  options: {
    readonly tasks?: boolean;
    readonly showEmptyState?: boolean;
  } = {},
): string {
  if (agents.length === 0) {
    if (options.showEmptyState !== true) return '';
    const { filterArg, catalog, qualifier } = cliAgentCatalogHint(
      options.tasks === true,
    );
    return `No visible ${qualifier} are enabled for this workspace. Use \`texra agents list${filterArg} --all\` to show ${catalog}.`;
  }

  // Shell completion reads the name column straight back into `texra run`,
  // `texra agents show` and `--agent`, so every row has to print a spelling
  // that resolves to that row. A bare name shared by two listed agents does
  // not — `texra run` refuses it as ambiguous — so those rows print the
  // source-qualified key instead, which hits exactly one registry entry.
  const nameCounts = new Map<string, number>();
  for (const agent of agents) {
    nameCounts.set(agent.name, (nameCounts.get(agent.name) ?? 0) + 1);
  }
  const collidingNames = new Set(
    [...nameCounts].filter(([, count]) => count > 1).map(([name]) => name),
  );
  return agents
    .map(
      (agent) =>
        `${agent.task === null ? 'chat' : 'task'}\t${collidingNames.has(agent.name) ? agentKeyOf(agent) : agent.name}\t${agent.description ?? ''}`,
    )
    .join('\n');
}

export function formatCliAgentDetails(entry: AgentEntry): string {
  const lines: string[] = [
    `name: ${entry.name}`,
    `kind: ${entry.task === null ? 'chat' : 'document task'}`,
    `source: ${entry.source}`,
  ];
  if (entry.path) lines.push(`path: ${entry.path}`);
  if (entry.description) {
    lines.push('');
    lines.push(entry.description);
  }
  const metadataFields: readonly [string, readonly string[] | undefined][] = [
    ['tools', entry.tools],
    ['outputs', entry.task?.outputs],
  ];
  const metadataLines = metadataFields.flatMap(([label, values]) =>
    values?.length ? [`${label}: ${values.join(', ')}`] : [],
  );
  if (metadataLines.length > 0) {
    lines.push('');
    lines.push(...metadataLines);
  }
  if (entry.rounds) {
    if (metadataLines.length === 0) lines.push('');
    lines.push(`revisions: ${entry.rounds}`);
  }
  return lines.join('\n');
}

export function formatCliNewerBuiltInNotice(name: string): string {
  return `A newer built-in version of ${name} is available; your custom copy still overrides it. Run \`texra agents reset ${name}\` to use the new version, or \`texra agents keep ${name}\` to keep yours.`;
}

export function formatCliHiddenAgentsNotice(
  hiddenCount: number,
  tasks = false,
): string | undefined {
  if (hiddenCount <= 0) return undefined;
  const { filterArg, catalog } = cliAgentCatalogHint(tasks);
  return `Showing visible agents only; ${formatResultCount(hiddenCount, 'hidden agent')} omitted. Use \`texra agents list${filterArg} --all\` to show ${catalog}.`;
}

function cliAgentCatalogHint(tasks: boolean): {
  readonly filterArg: string;
  readonly catalog: string;
  readonly qualifier: string;
} {
  return tasks
    ? {
        filterArg: ' --tasks',
        catalog: 'all document tasks',
        qualifier: 'document tasks',
      }
    : { filterArg: '', catalog: 'all agents', qualifier: 'agents' };
}

function collectCliAgents(
  stores: WorkspaceAgentsStores,
  source: 'all' | 'visible',
  tasks: boolean,
) {
  return Effect.map(
    source === 'visible'
      ? getVisibleAgents(stores)
      : Effect.succeed(getCatalogAgents()),
    (agents) =>
      tasks ? agents.filter((agent) => agent.task !== null) : agents,
  );
}
