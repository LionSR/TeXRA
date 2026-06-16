import {
  getAgent,
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
} from '@agent/index';
import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

import { getCliAuthProvider } from './supabaseAuth';

export interface CliAgentListOptions {
  readonly includeHidden?: boolean;
  readonly category?: AgentCategory;
}

export interface CliAgentListResult {
  readonly agents: readonly AgentEntry[];
  readonly hiddenCount: number;
}

const AGENT_CATEGORY_FILTER_ALIASES = [
  [AgentCategory.Workflow, AgentCategory.Workflow],
  [AgentCategory.ToolUse, AgentCategory.ToolUse],
  ['tool-use', AgentCategory.ToolUse],
  ['tool_use', AgentCategory.ToolUse],
] as const satisfies readonly (readonly [string, AgentCategory])[];

export const CLI_AGENT_CATEGORY_FILTER_VALUES =
  AGENT_CATEGORY_FILTER_ALIASES.map(([value]) => value);

const AGENT_CATEGORY_FILTERS = new Map<string, AgentCategory>(
  AGENT_CATEGORY_FILTER_ALIASES.map(([value, category]) => [
    value.toLowerCase(),
    category,
  ]),
);

const AGENT_CATEGORIES = [
  AgentCategory.Workflow,
  AgentCategory.ToolUse,
] as const satisfies readonly AgentCategory[];

export function parseCliAgentCategoryFilter(
  input: string | undefined,
): AgentCategory | undefined {
  const normalized = input?.trim();
  if (!normalized) return undefined;
  return AGENT_CATEGORY_FILTERS.get(normalized.toLowerCase());
}

/**
 * Resolve a CLI launch target from the agent registry.
 *
 * CLI commands start with a local-only load so signed-out users avoid remote
 * auth/network work. Missing agents still get a remote-inclusive fallback, and
 * authenticated relay sessions reload bare names so the registry's normal
 * source priority can prefer remote definitions. Category-specific commands
 * pass their category through to keep lookup priority owned by the registry.
 */
export async function resolveCliAgent(
  name: string,
  category?: AgentCategory,
): Promise<AgentEntry | undefined> {
  await loadAgents({ includeRemote: false });
  const agent = getAgent(name, category);

  if (!agent) {
    await loadAgents();
    return getAgent(name, category);
  }

  if (name.includes(':') || !(await getCliAuthProvider().isAuthenticated())) {
    return agent;
  }

  await loadAgents();
  return getAgent(name, category);
}

export async function loadCliAgentList(
  options: CliAgentListOptions = {},
): Promise<CliAgentListResult> {
  const includeHidden = options.includeHidden === true;
  await loadAgents(includeHidden ? undefined : { includeRemote: false });

  const agents = collectCliAgents(
    includeHidden ? 'all' : 'visible',
    options.category,
  );
  const hiddenCount = includeHidden
    ? 0
    : collectCliAgents('all', options.category).length - agents.length;

  return { agents, hiddenCount };
}

export function formatCliAgentList(agents: readonly AgentEntry[]): string {
  return agents
    .map(
      (agent) => `${agent.category}\t${agent.name}\t${agent.description ?? ''}`,
    )
    .join('\n');
}

export function formatCliAgentDetails(entry: AgentEntry): string {
  const lines: string[] = [];
  lines.push(`name: ${entry.name}`);
  lines.push(`category: ${entry.category}`);
  lines.push(`source: ${entry.source}`);
  if (entry.path) lines.push(`path: ${entry.path}`);
  if (entry.description) {
    lines.push('');
    lines.push(entry.description);
  }
  const metadataFields: readonly [string, readonly string[] | undefined][] = [
    ['tools', entry.tools],
    ['defaultOutputFiles', entry.defaultOutputFiles],
    ['visibility', entry.visibility],
  ];
  const metadataLines = metadataFields
    .filter(([, values]) => values && values.length > 0)
    .map(([label, values]) => `${label}: ${values!.join(', ')}`);
  if (metadataLines.length > 0) {
    lines.push('');
    lines.push(...metadataLines);
  }
  return lines.join('\n');
}

export function formatCliHiddenAgentsNotice(
  hiddenCount: number,
): string | undefined {
  if (hiddenCount <= 0) return undefined;
  return `Showing visible agents only; ${hiddenCount} hidden agent${hiddenCount === 1 ? '' : 's'} omitted. Use \`texra agents list --all\` to show the full catalog.`;
}

function collectCliAgents(
  source: 'all' | 'visible',
  categoryFilter?: AgentCategory,
): AgentEntry[] {
  const categories = categoryFilter ? [categoryFilter] : AGENT_CATEGORIES;
  return categories.flatMap((category) =>
    source === 'visible'
      ? getVisibleAgents(category)
      : getAgentsByCategory(category),
  );
}
