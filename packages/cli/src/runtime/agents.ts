import { Effect } from 'effect';

import {
  getAgent,
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
  resolveAgentForLaunch,
  type AgentEntry,
  type AgentRosterStores,
} from '@agent/index';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import {
  AGENT_CATEGORIES,
  AgentSourceSchema,
  agentKeyOf,
  agentName,
  AgentCategory,
} from '@shared/schemas';
import { formatResultCount } from '@utils/text/stringUtils';

import { CliUsageError } from './cliContext';

export interface CliAgentListOptions {
  readonly includeHidden?: boolean;
  readonly category?: AgentCategory;
}

interface CliAgentListResult {
  readonly agents: readonly AgentEntry[];
  readonly hiddenCount: number;
}

type CliAgentLaunchMode = 'chat' | 'workflowResume';

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
  workflowResume: {
    requiredCategory: AgentCategory.Workflow,
    missing: missingAgentMessage,
    mismatch: (name: string, actual: AgentEntry['category']) =>
      `Agent "${name}" is a ${actual} agent; this run was recorded as a workflow run and cannot resume against it.`,
  },
} as const;

export const AGENT_NAME_DESCRIPTION =
  'Agent name from `texra agents list` or `texra agents list --all`';

export const LAUNCHABLE_AGENT_NAME_DESCRIPTION =
  'Workflow or tool-use agent name from `texra agents list --all`';

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
  stores: AgentRosterStores,
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
    stores,
    category,
    identifier,
    pinned.success ? pinned.data : undefined,
  );
  return entry?.category === category ? entry : undefined;
}

/**
 * Validate a resolved entry for a category-pinned launch. Reports the refusal
 * as the `CliUsageError` value it is rather than throwing one: the launch
 * resolver below fails its Effect with it, and the chat slash command reads
 * its message, so neither has to catch a throw to tell a usage refusal from a
 * real fault.
 */
export function checkCliAgentLaunch(
  stores: AgentRosterStores,
  name: string,
  agent: AgentEntry | undefined,
  mode: CliAgentLaunchMode,
): AgentEntry | CliUsageError {
  const target = CLI_AGENT_LAUNCH_TARGETS[mode];
  if (agent?.category === target.requiredCategory) return agent;

  // Category-scoped resolution yields nothing for a wrong-category name, so
  // probe the other category to keep telling "wrong kind of agent" apart from
  // "no such agent".
  const otherCategory =
    target.requiredCategory === AgentCategory.ToolUse
      ? AgentCategory.Workflow
      : AgentCategory.ToolUse;
  const found = agent ?? resolveCliAgentInCategory(stores, name, otherCategory);
  return new CliUsageError(
    found ? target.mismatch(name, found.category) : target.missing(name),
  );
}

/**
 * Resolve a CLI-visible agent from the registry.
 *
 * CLI commands start with a local-only load so signed-out users avoid remote
 * auth/network work. Missing agents still get a remote-inclusive fallback, and
 * signed-in sessions reload bare names so the registry's normal
 * source priority can prefer remote definitions.
 *
 * A launch category resolves through the launch resolver, so validation lands
 * on the exact entry the launch will load; without one this is a display
 * lookup and stays category-blind.
 *
 * The catalog loads are Effect programs and so is this lookup: the entry
 * point that owns the process runtime settles it, and every caller already
 * inside a program composes it.
 */
export function resolveCliAgent(
  stores: AgentRosterStores,
  name: string,
  lookupCategory?: AgentCategory,
) {
  return Effect.gen(function* () {
    yield* loadAgents({ includeRemote: false });
    const agent = lookupCliAgent(stores, name, lookupCategory);

    // Keep the local hit only when a remote-inclusive reload could not change
    // it: a source-qualified name already pins its tier, and a signed-out
    // session has no remote catalog to prefer. Every other case (including a
    // local miss) falls through to the full load below.
    if (
      agent &&
      (name.includes(':') ||
        !(yield* Effect.flatMap(SupabaseAuth, (auth) => auth.authenticated)))
    ) {
      return agent;
    }

    yield* loadAgents();
    return lookupCliAgent(stores, name, lookupCategory);
  });
}

function lookupCliAgent(
  stores: AgentRosterStores,
  identifier: string,
  category: AgentCategory | undefined,
): AgentEntry | undefined {
  return category
    ? resolveCliAgentInCategory(stores, identifier, category)
    : getAgent(identifier);
}

/**
 * Resolve the agent `texra run <agent>` launches. One headless command serves
 * both categories, so a bare name can land in either — and a name carried by
 * both is refused, never silently resolved: the two categories run different
 * shapes, and preferring one would change what an existing invocation does
 * without saying so.
 *
 * The refusal is always escapable. The registry is a flat cache keyed by
 * `source:name`, so two entries sharing a name necessarily differ in source,
 * and a source-qualified identifier hits exactly one cache key — a same-source
 * collision is unrepresentable, not merely unhandled.
 */
export function resolveCliRunAgent(stores: AgentRosterStores, name: string) {
  return Effect.gen(function* () {
    const workflow = yield* resolveCliAgent(
      stores,
      name,
      AgentCategory.Workflow,
    );
    // The pass above already loaded the catalog this lookup reads: it returns
    // before the remote-inclusive reload only for a source-qualified name (which
    // pins one cache key, so it cannot also hit here) or a signed-out session
    // (which has no remote catalog to add).
    const toolUse = resolveCliAgentInCategory(
      stores,
      name,
      AgentCategory.ToolUse,
    );
    if (workflow && toolUse) {
      return yield* Effect.fail(
        new CliUsageError(ambiguousRunAgentMessage(name, workflow, toolUse)),
      );
    }
    const agent = workflow ?? toolUse;
    if (!agent) {
      return yield* Effect.fail(new CliUsageError(missingAgentMessage(name)));
    }
    return agent;
  });
}

function ambiguousRunAgentMessage(
  name: string,
  workflow: AgentEntry,
  toolUse: AgentEntry,
): string {
  const workflowKey = agentKeyOf(workflow);
  const toolUseKey = agentKeyOf(toolUse);
  return `Agent name "${name}" is ambiguous: it matches the ${AgentCategory.Workflow} agent ${workflowKey} and the ${AgentCategory.ToolUse} agent ${toolUseKey}. Re-run with the source-qualified name to pick one: \`texra run ${workflowKey}\` or \`texra run ${toolUseKey}\`.`;
}

/**
 * Resolve and validate an agent for a category-pinned CLI launch.
 */
export function resolveCliLaunchAgent(
  stores: AgentRosterStores,
  name: string,
  mode: CliAgentLaunchMode,
) {
  const target = CLI_AGENT_LAUNCH_TARGETS[mode];
  return Effect.gen(function* () {
    const resolved = yield* resolveCliAgent(
      stores,
      name,
      target.requiredCategory,
    );
    const agent = checkCliAgentLaunch(stores, name, resolved, mode);
    return agent instanceof CliUsageError ? yield* Effect.fail(agent) : agent;
  });
}

export function loadCliAgentList(
  stores: AgentRosterStores,
  options: CliAgentListOptions = {},
) {
  const includeHidden = options.includeHidden === true;
  return Effect.gen(function* () {
    yield* loadAgents(includeHidden ? undefined : { includeRemote: false });

    const agents = collectCliAgents(
      stores,
      includeHidden ? 'all' : 'visible',
      options.category,
    );
    const hiddenCount = includeHidden
      ? 0
      : collectCliAgents(stores, 'all', options.category).length -
        agents.length;

    return { agents, hiddenCount } satisfies CliAgentListResult;
  });
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
        `${agent.category}\t${collidingNames.has(agent.name) ? agentKeyOf(agent) : agent.name}\t${agent.description ?? ''}`,
    )
    .join('\n');
}

export function formatCliAgentDetails(entry: AgentEntry): string {
  const lines: string[] = [
    `name: ${entry.name}`,
    `category: ${entry.category}`,
    `source: ${entry.source}`,
  ];
  if (entry.path) lines.push(`path: ${entry.path}`);
  if (entry.description) {
    lines.push('');
    lines.push(entry.description);
  }
  const metadataFields: readonly [string, readonly string[] | undefined][] = [
    ['tools', entry.tools],
    ['defaultOutputFiles', entry.defaultOutputFiles],
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
  stores: AgentRosterStores,
  source: 'all' | 'visible',
  categoryFilter?: AgentCategory,
): AgentEntry[] {
  const categories = categoryFilter ? [categoryFilter] : AGENT_CATEGORIES;
  return categories.flatMap((category) =>
    source === 'visible'
      ? getVisibleAgents(stores, category)
      : getAgentsByCategory(category),
  );
}
