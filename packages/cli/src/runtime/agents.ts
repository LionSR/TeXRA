import {
  getAgent,
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
  resolveAgentForLaunch,
} from '@agent/index';
import type { AgentEntry } from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  AGENT_CATEGORIES,
  AgentSourceSchema,
  agentName,
  AgentCategory,
} from '@shared/schemas';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { formatResultCount } from '@utils/text/stringUtils';

import { CliUsageError } from './cliContext';

export interface CliAgentListOptions {
  readonly includeHidden?: boolean;
  readonly category?: AgentCategory;
}

export interface CliAgentListResult {
  readonly agents: readonly AgentEntry[];
  readonly hiddenCount: number;
}

export type CliAgentLaunchMode = 'chat' | 'run' | 'agentsRun';

const AGENT_LOOKUP_HINT =
  'Use `texra agents list` for visible starter agents, `texra agents list --all` for every agent, or pass a known launchable agent name from a team preset.';
const MULTI_AGENT_PRESET_LOOKUP_HINT =
  'Use `texra multi-agent list` for available team presets, then run `texra multi-agent show <preset>` to check a team before launch.';

const CLI_AGENT_LAUNCH_TARGETS = {
  chat: {
    requiredCategory: AgentCategory.ToolUse,
    missing: missingToolUseAgentMessage,
    mismatch: (name: string, actual: AgentEntry['category']) =>
      `Agent "${name}" is a ${actual} agent; \`texra chat\` only handles tool-use agents. Use \`texra run ${name}\` for workflow agents, or \`texra multi-agent run <preset>\` for teams.`,
  },
  run: {
    requiredCategory: AgentCategory.Workflow,
    missing: missingAgentMessage,
    mismatch: (name: string, actual: AgentEntry['category']) =>
      `Agent "${name}" is a ${actual} agent; \`texra run\` only handles workflow agents. Start it interactively with \`texra chat --agent ${name}\`, or run a headless team with \`texra multi-agent run\`.`,
  },
  agentsRun: {
    requiredCategory: AgentCategory.ToolUse,
    missing: missingToolUseAgentMessage,
    mismatch: (name: string, actual: AgentEntry['category']) =>
      `Agent "${name}" is a ${actual} agent; \`texra agents run\` only handles tool-use agents. Use \`texra run ${name}\` for workflow agents.`,
  },
} as const;

export const AGENT_NAME_DESCRIPTION =
  'Agent name from `texra agents list` or `texra agents list --all`';

export const WORKFLOW_AGENT_NAME_DESCRIPTION =
  'Workflow agent name from `texra agents list --category workflow --all`';

export const TOOL_USE_AGENT_NAME_DESCRIPTION =
  'Tool-use agent name from `texra agents list --category toolUse --all`';

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

export function parseCliAgentCategoryFilter(
  input: string | undefined,
): AgentCategory | undefined {
  const normalized = input?.trim();
  if (!normalized) return undefined;
  return AGENT_CATEGORY_FILTERS.get(normalized.toLowerCase());
}

export function missingAgentMessage(name: string): string {
  return `Agent not found: ${name}. ${AGENT_LOOKUP_HINT}`;
}

export function missingToolUseAgentMessage(name: string): string {
  return `Tool-use agent not found: ${name}. ${AGENT_LOOKUP_HINT}`;
}

export function missingMultiAgentPresetMessage(name: string): string {
  return `Multi-agent preset not found: ${name}. ${MULTI_AGENT_PRESET_LOOKUP_HINT}`;
}

/**
 * Resolve an identifier the way launch resolves it: scoped to `category`, with
 * a valid `source:name` prefix carried as the pinned source so a name shadowed
 * by a higher-priority source still lands on the entry the user named. Returns
 * undefined when the identifier resolves outside `category` — including through
 * the pinned-source tier, which is category-blind by design.
 */
export function resolveCliAgentInCategory(
  identifier: string,
  category: AgentCategory,
): AgentEntry | undefined {
  const name = agentName(identifier);
  const pinned = AgentSourceSchema.safeParse(
    identifier === name
      ? undefined
      : identifier.slice(0, identifier.length - name.length - 1),
  );
  const entry = resolveAgentForLaunch(
    category,
    identifier,
    pinned.success ? pinned.data : undefined,
  )?.entry;
  return entry?.category === category ? entry : undefined;
}

/** Whether a CLI tool-use agent's tool list intersects the delegation tool set. */
export function chatAgentSupportsDelegation(name: string): boolean {
  return (
    resolveCliAgentInCategory(name, AgentCategory.ToolUse)?.tools?.some(
      (toolName) => DELEGATION_TOOLS.has(toolName),
    ) ?? false
  );
}

export function assertCliAgentLaunch(
  name: string,
  agent: AgentEntry | undefined,
  mode: CliAgentLaunchMode,
): AgentEntry {
  const target = CLI_AGENT_LAUNCH_TARGETS[mode];
  if (agent?.category === target.requiredCategory) return agent;

  // Category-scoped resolution yields nothing for a wrong-category name, so
  // probe the other category to keep telling "wrong kind of agent" apart from
  // "no such agent".
  const otherCategory =
    target.requiredCategory === AgentCategory.ToolUse
      ? AgentCategory.Workflow
      : AgentCategory.ToolUse;
  const found = agent ?? resolveCliAgentInCategory(name, otherCategory);
  if (!found) throw new CliUsageError(target.missing(name));
  throw new CliUsageError(target.mismatch(name, found.category));
}

/**
 * Resolve a CLI-visible agent from the registry.
 *
 * CLI commands start with a local-only load so signed-out users avoid remote
 * auth/network work. Missing agents still get a remote-inclusive fallback, and
 * authenticated relay sessions reload bare names so the registry's normal
 * source priority can prefer remote definitions.
 *
 * A launch category resolves through the launch resolver, so validation lands
 * on the exact entry the launch will load; without one this is a display
 * lookup and stays category-blind.
 */
export async function resolveCliAgent(
  name: string,
  lookupCategory?: AgentCategory,
): Promise<AgentEntry | undefined> {
  await loadAgents({ includeRemote: false });
  const agent = lookupCliAgent(name, lookupCategory);

  if (!agent) {
    await loadAgents();
    return lookupCliAgent(name, lookupCategory);
  }

  if (
    name.includes(':') ||
    !(await SupabaseClient.canAccessRemoteAgentCatalog())
  ) {
    return agent;
  }

  await loadAgents();
  return lookupCliAgent(name, lookupCategory);
}

function lookupCliAgent(
  identifier: string,
  category: AgentCategory | undefined,
): AgentEntry | undefined {
  return category
    ? resolveCliAgentInCategory(identifier, category)
    : getAgent(identifier);
}

/**
 * Resolve and validate an agent for a CLI launch command.
 */
export async function resolveCliLaunchAgent(
  name: string,
  mode: CliAgentLaunchMode,
): Promise<AgentEntry> {
  const target = CLI_AGENT_LAUNCH_TARGETS[mode];
  return assertCliAgentLaunch(
    name,
    await resolveCliAgent(name, target.requiredCategory),
    mode,
  );
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

export function formatCliAgentList(
  agents: readonly AgentEntry[],
  options: {
    readonly category?: AgentCategory;
    readonly showEmptyState?: boolean;
  } = {},
): string {
  if (agents.length === 0) {
    if (options.showEmptyState !== true) return '';
    const { categoryArg, catalog, qualifier } = cliAgentCatalogHint(
      options.category,
    );
    return `No visible ${qualifier}agents are enabled for this workspace. Use \`texra agents list${categoryArg} --all\` to show ${catalog}.`;
  }

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
  const metadataLines = metadataFields.flatMap(([label, values]) =>
    values?.length ? [`${label}: ${values.join(', ')}`] : [],
  );
  if (metadataLines.length > 0) {
    lines.push('');
    lines.push(...metadataLines);
  }
  if (entry.rounds) {
    if (metadataLines.length === 0) lines.push('');
    lines.push(`rounds: ${entry.rounds}`);
  }
  return lines.join('\n');
}

export function formatCliHiddenAgentsNotice(
  hiddenCount: number,
  category?: AgentCategory,
): string | undefined {
  if (hiddenCount <= 0) return undefined;
  const { categoryArg, catalog } = cliAgentCatalogHint(category);
  return `Showing visible agents only; ${formatResultCount(hiddenCount, 'hidden agent')} omitted. Use \`texra agents list${categoryArg} --all\` to show ${catalog}.`;
}

function cliAgentCatalogHint(category?: AgentCategory): {
  readonly categoryArg: string;
  readonly catalog: string;
  readonly qualifier: string;
} {
  const categoryLabel =
    category === AgentCategory.ToolUse ? 'tool-use' : category;
  return {
    categoryArg: category ? ` --category ${category}` : '',
    catalog: categoryLabel ? `all ${categoryLabel} agents` : 'all agents',
    qualifier: categoryLabel ? `${categoryLabel} ` : '',
  };
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
