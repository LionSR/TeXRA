import { Effect } from 'effect';

import {
  AgentCatalog,
  agentToolNames,
  type AgentEntry,
} from '@texra-ai/harness/host';
import { agentKeyOf } from '@texra-ai/harness/schemas';

import { CliUsageError } from './platform/cliContext';

const AGENT_LOOKUP_HINT = 'Use `texra agents list` for the agents.';

export const AGENT_NAME_DESCRIPTION = 'Agent name from `texra agents list`';

export const RUN_TARGET_NAME_DESCRIPTION =
  'Program name (an unknown name prints the programs) or agent name from `texra agents list`';

export function missingAgentMessage(name: string): string {
  return `Agent not found: ${name}. ${AGENT_LOOKUP_HINT}`;
}

/** The error for a `texra run` name that is neither a program nor an agent. */
export function missingRunTargetMessage(
  name: string,
  programNames: readonly string[],
): string {
  return `No program or agent is named ${name}. Programs: ${programNames.toSorted().join(', ')}. ${AGENT_LOOKUP_HINT}`;
}

/**
 * Resolve the agent a launch names, through the launch resolver, so the
 * check lands on the exact entry the launch loads. A name nothing resolves is
 * a usage error saying `notFoundMessage`.
 */
export function resolveCliRunAgent(
  name: string,
  notFoundMessage = missingAgentMessage(name),
) {
  return Effect.flatMap(AgentCatalog, (catalog) =>
    catalog
      .forLaunch(name)
      .pipe(
        Effect.catchTag('AgentNotFound', () =>
          Effect.fail(new CliUsageError({ message: notFoundMessage })),
        ),
      ),
  );
}

export function formatCliAgentList(
  agents: readonly AgentEntry[],
  options: { readonly showEmptyState?: boolean } = {},
): string {
  if (agents.length === 0) {
    if (options.showEmptyState !== true) return '';
    return 'No agents are installed.';
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
        `${collidingNames.has(agent.name) ? agentKeyOf(agent) : agent.name}\t${agent.description ?? ''}`,
    )
    .join('\n');
}

export function formatCliAgentDetails(entry: AgentEntry): string {
  const lines: string[] = [`name: ${entry.name}`, `source: ${entry.source}`];
  if (entry.path) lines.push(`path: ${entry.path}`);
  if (entry.description) {
    lines.push('');
    lines.push(entry.description);
  }
  const tools = agentToolNames(entry);
  if (tools.length > 0) {
    lines.push('');
    lines.push(`tools: ${tools.join(', ')}`);
  }
  return lines.join('\n');
}

export function formatCliNewerBuiltInNotice(name: string): string {
  return `A newer built-in version of ${name} is available; your custom copy still overrides it. Run \`texra agents reset ${name}\` to use the new version, or \`texra agents keep ${name}\` to keep yours.`;
}
