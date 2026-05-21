import { platform } from '@platform/platform';
import type { AgentEntry } from '@agent/index';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { agentKey } from '@shared/schemas/agent';
import {
  AGENT_MODE_PRESETS,
  AgentModePresetSchema,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';

export type CliMultiAgentPresetSource = 'built-in' | 'custom';

export interface CliMultiAgentPreset extends AgentModePreset {
  readonly source: CliMultiAgentPresetSource;
}

export interface CliMultiAgentPresetRunPlan {
  readonly preset: CliMultiAgentPreset;
  readonly rootAgent?: AgentEntry;
  readonly workflowAgentKeys: readonly string[];
  readonly toolUseAgentKeys: readonly string[];
  readonly missingWorkflowAgents: readonly string[];
  readonly missingToolUseAgents: readonly string[];
}

export function parseCliCustomAgentPresets(raw: unknown): AgentModePreset[] {
  return AgentModePresetSchema.array().catch([]).parse(raw);
}

export function readCliMultiAgentPresets(): CliMultiAgentPreset[] {
  const customRaw = platform().workspaceState.get<unknown>(
    WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
  );
  return cliMultiAgentPresets(customRaw);
}

export function cliMultiAgentPresets(
  customRaw: unknown,
): CliMultiAgentPreset[] {
  return [
    ...AGENT_MODE_PRESETS.map((preset) => withSource(preset, 'built-in')),
    ...parseCliCustomAgentPresets(customRaw).map((preset) =>
      withSource(preset, 'custom'),
    ),
  ];
}

export function findCliMultiAgentPreset(
  presets: readonly CliMultiAgentPreset[],
  query: string,
): CliMultiAgentPreset | undefined {
  const key = lookupKey(query);
  return presets.find(
    (preset) =>
      lookupKey(preset.id) === key ||
      lookupKey(preset.name) === key ||
      slugKey(preset.name) === key,
  );
}

export function formatCliMultiAgentPresetList(
  presets: readonly CliMultiAgentPreset[],
): string {
  if (presets.length === 0) return 'No multi-agent presets found.';

  return presets
    .map((preset) =>
      [
        preset.source,
        preset.id,
        preset.name,
        `workflow:${preset.workflowAgents.length}`,
        `tool-use:${preset.toolUseAgents.length}`,
      ].join('\t'),
    )
    .join('\n');
}

export function formatCliMultiAgentPresetDetails(
  preset: CliMultiAgentPreset,
): string {
  return [
    `${preset.name} (${preset.id})`,
    `Source: ${preset.source}`,
    `Description: ${preset.description}`,
    'Workflow agents:',
    formatAgentNames(preset.workflowAgents),
    'Tool-use agents:',
    formatAgentNames(preset.toolUseAgents),
  ].join('\n');
}

export function cliMultiAgentPresetNdjsonRecords(
  presets: readonly CliMultiAgentPreset[],
): unknown[] {
  const ts = new Date().toISOString();
  return presets.map((preset) => ({
    kind: 'multi-agent-preset',
    ts,
    preset,
  }));
}

/**
 * True when a planned run is missing any preset member — either no root agent
 * could be selected, or some workflow/tool-use agents the preset names aren't
 * resolvable from the loaded registry. Used to decide whether a remote agent
 * load is worth attempting for an authenticated user (relay-served premium
 * agents like the orchestrator and delegation specialists are only visible
 * after a remote load).
 */
export function cliMultiAgentPlanHasGaps(
  plan: CliMultiAgentPresetRunPlan,
): boolean {
  return (
    !plan.rootAgent ||
    plan.missingWorkflowAgents.length > 0 ||
    plan.missingToolUseAgents.length > 0
  );
}

export function planCliMultiAgentPresetRun(
  preset: CliMultiAgentPreset,
  options: {
    readonly workflowAgents: readonly AgentEntry[];
    readonly toolUseAgents: readonly AgentEntry[];
    readonly agentOverride?: string;
  },
): CliMultiAgentPresetRunPlan {
  const workflow = resolvePresetAgents(
    preset.workflowAgents,
    options.workflowAgents,
  );
  const toolUse = resolvePresetAgents(
    preset.toolUseAgents,
    options.toolUseAgents,
  );
  const overrideAgent = resolveAgentOverride(
    options.agentOverride,
    options.toolUseAgents,
  );
  const rootAgent =
    overrideAgent ??
    selectPresetRootAgent(toolUse.resolved, preset.toolUseAgents);
  const toolUseAgents = rootAgent
    ? includeAgent(toolUse.resolved, rootAgent)
    : toolUse.resolved;

  return {
    preset,
    rootAgent,
    workflowAgentKeys: workflow.resolved.map(toAgentKey),
    toolUseAgentKeys: toolUseAgents.map(toAgentKey),
    missingWorkflowAgents: workflow.missing,
    missingToolUseAgents: toolUse.missing,
  };
}

export async function withCliMultiAgentPresetVisibility<T>(
  plan: CliMultiAgentPresetRunPlan,
  operation: () => Promise<T>,
): Promise<T> {
  const workspaceState = platform().workspaceState;
  const previousWorkflowAgents = workspaceState.get<string[] | undefined>(
    WorkspaceStateKey.ENABLED_AGENTS,
  );
  const previousToolUseAgents = workspaceState.get<string[] | undefined>(
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
  );

  await workspaceState.update(WorkspaceStateKey.ENABLED_AGENTS, [
    ...plan.workflowAgentKeys,
  ]);
  await workspaceState.update(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS, [
    ...plan.toolUseAgentKeys,
  ]);

  try {
    return await operation();
  } finally {
    await workspaceState.update(
      WorkspaceStateKey.ENABLED_AGENTS,
      previousWorkflowAgents,
    );
    await workspaceState.update(
      WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      previousToolUseAgents,
    );
  }
}

function withSource(
  preset: AgentModePreset,
  source: CliMultiAgentPresetSource,
): CliMultiAgentPreset {
  return { ...preset, source };
}

function resolvePresetAgents(
  names: readonly string[],
  agents: readonly AgentEntry[],
): { resolved: AgentEntry[]; missing: string[] } {
  const resolved: AgentEntry[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const entry = agents.find((agent) => agent.name === name);
    if (entry) {
      resolved.push(entry);
    } else {
      missing.push(name);
    }
  }
  return { resolved, missing };
}

function resolveAgentOverride(
  override: string | undefined,
  agents: readonly AgentEntry[],
): AgentEntry | undefined {
  const query = override?.trim();
  if (!query) return undefined;
  return agents.find(
    (agent) => agent.name === query || toAgentKey(agent) === query,
  );
}

function selectPresetRootAgent(
  agents: readonly AgentEntry[],
  presetOrder: readonly string[],
): AgentEntry | undefined {
  const delegatingAgents = agents.filter(agentHasDelegationTools);
  if (delegatingAgents.length > 0) {
    return (
      findPreferredRootAgent(delegatingAgents, presetOrder) ??
      delegatingAgents[0]
    );
  }
  return agents[0];
}

function findPreferredRootAgent(
  agents: readonly AgentEntry[],
  presetOrder: readonly string[],
): AgentEntry | undefined {
  const searchOrder = ['orchestrator', 'leanOrchestrator', ...presetOrder];
  for (const name of searchOrder) {
    const entry = agents.find((agent) => agent.name === name);
    if (entry) return entry;
  }
  return undefined;
}

function includeAgent(
  agents: readonly AgentEntry[],
  rootAgent: AgentEntry,
): AgentEntry[] {
  return agents.some((agent) => toAgentKey(agent) === toAgentKey(rootAgent))
    ? [...agents]
    : [...agents, rootAgent];
}

function agentHasDelegationTools(agent: AgentEntry): boolean {
  return agent.tools?.some((tool) => DELEGATION_TOOLS.has(tool)) ?? false;
}

function toAgentKey(agent: AgentEntry): string {
  return agentKey(agent.source, agent.name);
}

function formatAgentNames(names: readonly string[]): string {
  if (names.length === 0) return '  (none)';
  return names.map((name) => `  ${name}`).join('\n');
}

function lookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function slugKey(value: string): string {
  return lookupKey(value).replaceAll(/\s+/g, '-');
}
