import {
  getToolUseAgents,
  getVisibleAgents,
  getWorkflowAgents,
  loadAgents,
} from '@agent/index';
import type { AgentEntry } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

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

const ALL_AGENT_LOADERS = {
  [AgentCategory.Workflow]: getWorkflowAgents,
  [AgentCategory.ToolUse]: getToolUseAgents,
} satisfies Record<AgentCategory, () => AgentEntry[]>;

export function parseCliAgentCategoryFilter(
  input: string | undefined,
): AgentCategory | undefined {
  const normalized = input?.trim();
  if (!normalized) return undefined;
  return AGENT_CATEGORY_FILTERS.get(normalized.toLowerCase());
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
  const metadataLines: string[] = [];
  if (entry.tools && entry.tools.length > 0) {
    metadataLines.push(`tools: ${entry.tools.join(', ')}`);
  }
  if (entry.defaultOutputFiles && entry.defaultOutputFiles.length > 0) {
    metadataLines.push(
      `defaultOutputFiles: ${entry.defaultOutputFiles.join(', ')}`,
    );
  }
  if (entry.visibility && entry.visibility.length > 0) {
    metadataLines.push(`visibility: ${entry.visibility.join(', ')}`);
  }
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
      : ALL_AGENT_LOADERS[category](),
  );
}
