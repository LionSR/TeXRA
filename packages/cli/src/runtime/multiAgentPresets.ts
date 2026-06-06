import { platform } from '@platform/platform';
import type { AgentEntry } from '@agent/index';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { agentKey } from '@shared/schemas/agent';
import {
  AGENT_MODE_PRESETS,
  AgentModePresetSchema,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import { implicitDefaultToolUseAgents } from './defaultAgents';

export type CliMultiAgentPresetSource = 'built-in' | 'custom';

export interface CliMultiAgentPreset extends AgentModePreset {
  readonly source: CliMultiAgentPresetSource;
}

export interface CliMultiAgentPresetRunPlan {
  readonly preset: CliMultiAgentPreset;
  readonly rootAgent?: AgentEntry;
  readonly missingAgentOverride?: string;
  readonly workflowAgentKeys: readonly string[];
  readonly toolUseAgentKeys: readonly string[];
  readonly missingWorkflowAgents: readonly string[];
  readonly missingToolUseAgents: readonly string[];
}

export interface CliMultiAgentPresetFormatOptions {
  readonly includeLoginHint?: boolean;
}

export interface CliMultiAgentTeamLaunchBlockMessageOptions {
  readonly requestedPreset?: string;
  readonly followUpAdvice?: string;
}

export type CliMultiAgentPlanStatus = 'available' | 'degraded' | 'unavailable';

export interface CliMultiAgentPresetAgentAvailability {
  readonly available: number;
  readonly total: number;
  readonly missing: readonly string[];
  readonly label: string;
}

export interface CliMultiAgentPresetAvailability {
  readonly status: CliMultiAgentPlanStatus;
  readonly workflow: CliMultiAgentPresetAgentAvailability;
  readonly toolUse: CliMultiAgentPresetAgentAvailability;
  readonly rootAgent?: {
    readonly key: string;
    readonly name: string;
    readonly source: AgentEntry['source'];
  };
  readonly missingAgentOverride?: string;
}

/**
 * Machine-readable `multi-agent list` record. It preserves the raw preset
 * fields so existing consumers still see a preset-shaped object, while adding
 * the planned availability that list output needs. `multi-agent show` continues
 * to emit the raw `CliMultiAgentPreset` because it is definition-focused and
 * does not load the agent registry.
 */
export interface CliMultiAgentPresetListRecord extends CliMultiAgentPreset {
  readonly availability: CliMultiAgentPresetAvailability;
}

const MULTI_AGENT_TEAM_ROOT_AGENT_LABEL = 'Team root agent';
export const MULTI_AGENT_TEAM_ROOT_AGENT_DESCRIPTION =
  'Root agent for the team run (defaults to the preset orchestrator)';
export const MULTI_AGENT_TEAM_ROOT_MODEL_DESCRIPTION =
  'Model for the team root agent';
const BUILT_IN_TEAM_ROOT_AGENT_NAMES = ['orchestrator', 'leanOrchestrator'];
const MULTI_AGENT_INSPECT_HINT = `Hint: run \`${formatCliMultiAgentInspectCommand('<preset>')}\` to see missing agents for degraded or unavailable presets.`;
const MULTI_AGENT_LOGIN_HINT =
  'Hint: built-in teams may load additional relay-served agents after `texra login`.';
const MULTI_AGENT_LAUNCHER_INSPECT_HINT = `Team setup: run ${formatCliMultiAgentInspectCommand('<preset>')}.`;
const MULTI_AGENT_LAUNCHER_LOGIN_HINT =
  'Relay teams may unlock more agents after texra login.';

export function formatCliMultiAgentInspectCommand(preset: string): string {
  return `texra multi-agent inspect ${preset}`;
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
    ...AGENT_MODE_PRESETS.map((preset) => ({
      ...preset,
      source: 'built-in' as const,
    })),
    ...parseCliCustomAgentPresets(customRaw).map((preset) => ({
      ...preset,
      source: 'custom' as const,
    })),
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

export function planCliMultiAgentPresets(
  presets: readonly CliMultiAgentPreset[],
  options: {
    readonly workflowAgents: readonly AgentEntry[];
    readonly toolUseAgents: readonly AgentEntry[];
  },
): CliMultiAgentPresetRunPlan[] {
  return presets.map((preset) => planCliMultiAgentPresetRun(preset, options));
}

export function cliMultiAgentPresetAvailabilityParts(
  plan: CliMultiAgentPresetRunPlan,
): string[] {
  const status = cliMultiAgentPlanStatus(plan);
  const parts = [
    `workflow:${formatAvailablePresetAgentCount(plan.preset.workflowAgents, plan.missingWorkflowAgents)}`,
    `tool-use:${formatAvailablePresetAgentCount(plan.preset.toolUseAgents, plan.missingToolUseAgents)}`,
  ];
  if (status !== 'available') parts.push(status);
  return parts;
}

export function formatCliMultiAgentPresetLauncherSummary(
  plan: CliMultiAgentPresetRunPlan,
): string {
  const availability = cliMultiAgentPresetAvailability(plan);
  const status =
    availability.status === 'available' ? 'ready' : availability.status;
  const details = formatPresetAvailabilityForLauncher(
    availability,
    cliMultiAgentPresetTeamLaunchBlockReason(plan),
  );

  return [status, details].filter((part): part is string => !!part).join('; ');
}

export function formatCliMultiAgentPresetLauncherHints(
  plan: CliMultiAgentPresetRunPlan,
  options: CliMultiAgentPresetFormatOptions = {},
): readonly string[] {
  return [
    cliMultiAgentPlanStatus(plan) !== 'available'
      ? MULTI_AGENT_LAUNCHER_INSPECT_HINT
      : undefined,
    shouldIncludeBuiltInLoginHint(plan, options)
      ? MULTI_AGENT_LAUNCHER_LOGIN_HINT
      : undefined,
  ].filter((hint): hint is string => hint !== undefined);
}

export function formatCliMultiAgentPresetList(
  plans: readonly CliMultiAgentPresetRunPlan[],
  options: CliMultiAgentPresetFormatOptions = {},
): string {
  if (plans.length === 0) return 'No multi-agent presets found.';

  const rows = plans.map((plan) =>
    [
      plan.preset.source,
      plan.preset.id,
      plan.preset.name,
      ...cliMultiAgentPresetAvailabilityParts(plan),
    ].join('\t'),
  );

  const hint = cliMultiAgentPresetListHint(plans, options);
  return hint ? [...rows, '', hint].join('\n') : rows.join('\n');
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

export function formatCliMultiAgentPresetInspection(
  plan: CliMultiAgentPresetRunPlan,
  options: CliMultiAgentPresetFormatOptions = {},
): string {
  const availableWorkflowAgents = availablePresetAgents(
    plan.preset.workflowAgents,
    plan.missingWorkflowAgents,
  );
  const availableToolUseAgents = availablePresetAgents(
    plan.preset.toolUseAgents,
    plan.missingToolUseAgents,
  );

  const lines = [
    `${plan.preset.name} (${plan.preset.id})`,
    `Source: ${plan.preset.source}`,
    `Description: ${plan.preset.description}`,
    `${MULTI_AGENT_TEAM_ROOT_AGENT_LABEL}:`,
    `  ${plan.rootAgent?.name ?? '(none)'}`,
    'Available workflow agents:',
    formatAgentNames(availableWorkflowAgents),
    'Available tool-use agents:',
    formatAgentNames(availableToolUseAgents),
    'Missing workflow agents:',
    formatAgentNames(plan.missingWorkflowAgents),
    'Missing tool-use agents:',
    formatAgentNames(plan.missingToolUseAgents),
  ];
  if (shouldIncludeBuiltInLoginHint(plan, options)) {
    lines.push('', MULTI_AGENT_LOGIN_HINT);
  }
  return lines.join('\n');
}

export function cliMultiAgentPresetNdjsonRecords(
  plans: readonly CliMultiAgentPresetRunPlan[],
): object[] {
  const ts = new Date().toISOString();
  return plans.map((plan) => ({
    kind: 'multi-agent-preset',
    ts,
    preset: cliMultiAgentPresetListRecord(plan),
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
    plan.missingAgentOverride !== undefined ||
    plan.missingWorkflowAgents.length > 0 ||
    plan.missingToolUseAgents.length > 0
  );
}

export function cliMultiAgentPlanStatus(
  plan: CliMultiAgentPresetRunPlan,
): CliMultiAgentPlanStatus {
  if (cliMultiAgentPresetTeamLaunchBlockReason(plan)) return 'unavailable';
  return cliMultiAgentPlanHasGaps(plan) ? 'degraded' : 'available';
}

export function cliMultiAgentPresetTeamLaunchBlockReason(
  plan: CliMultiAgentPresetRunPlan,
): string | undefined {
  if (!plan.rootAgent) return 'no runnable team root';
  if (!agentHasDelegationTools(plan.rootAgent)) {
    return `root ${plan.rootAgent.name} cannot delegate`;
  }
  if (availablePresetTeamMemberCount(plan) === 0) {
    return 'no available team members';
  }
  return undefined;
}

export function cliMultiAgentPresetCanLaunchTeam(
  plan: CliMultiAgentPresetRunPlan,
): plan is CliMultiAgentPresetRunPlan & { readonly rootAgent: AgentEntry } {
  return cliMultiAgentPresetTeamLaunchBlockReason(plan) === undefined;
}

export function formatCliMultiAgentTeamLaunchBlockMessage(
  plan: CliMultiAgentPresetRunPlan,
  options: CliMultiAgentTeamLaunchBlockMessageOptions = {},
): string {
  const preset = options.requestedPreset ?? plan.preset.id;
  const reason = cliMultiAgentPresetTeamLaunchBlockReason(plan);
  if (!reason) {
    throw new Error(
      `Cannot format team launch block for launchable multi-agent preset "${plan.preset.id}".`,
    );
  }
  const parts = [
    `Multi-agent preset "${preset}" cannot start as a team: ${reason}.`,
    `Run \`${formatCliMultiAgentInspectCommand(plan.preset.id)}\` to see missing agents.`,
    options.followUpAdvice,
  ];
  return parts.filter((part): part is string => !!part).join(' ');
}

export function cliMultiAgentPresetAvailability(
  plan: CliMultiAgentPresetRunPlan,
): CliMultiAgentPresetAvailability {
  return {
    status: cliMultiAgentPlanStatus(plan),
    workflow: presetAgentAvailability(
      plan.preset.workflowAgents,
      plan.missingWorkflowAgents,
    ),
    toolUse: presetAgentAvailability(
      plan.preset.toolUseAgents,
      plan.missingToolUseAgents,
    ),
    rootAgent: plan.rootAgent
      ? {
          key: toAgentKey(plan.rootAgent),
          name: plan.rootAgent.name,
          source: plan.rootAgent.source,
        }
      : undefined,
    missingAgentOverride: plan.missingAgentOverride,
  };
}

export function cliMultiAgentPresetListRecord(
  plan: CliMultiAgentPresetRunPlan,
): CliMultiAgentPresetListRecord {
  return {
    ...plan.preset,
    availability: cliMultiAgentPresetAvailability(plan),
  };
}

export function cliMultiAgentPresetListRecords(
  plans: readonly CliMultiAgentPresetRunPlan[],
): CliMultiAgentPresetListRecord[] {
  return plans.map(cliMultiAgentPresetListRecord);
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
  const override = resolveAgentOverride(
    options.agentOverride,
    options.toolUseAgents,
  );
  const rootAgent =
    override.agent ??
    selectPresetRootAgent(toolUse.resolved, {
      presetOrder: preset.toolUseAgents,
      presetSource: preset.source,
    });
  const toolUseAgents = rootAgent
    ? includeAgent(toolUse.resolved, rootAgent)
    : toolUse.resolved;

  return {
    preset,
    rootAgent,
    missingAgentOverride: override.missing,
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
): { agent?: AgentEntry; missing?: string } {
  const query = override?.trim();
  if (!query) return {};
  const agent = agents.find(
    (agent) => agent.name === query || toAgentKey(agent) === query,
  );
  return agent ? { agent } : { missing: query };
}

function selectPresetRootAgent(
  agents: readonly AgentEntry[],
  options: {
    readonly presetOrder: readonly string[];
    readonly presetSource: CliMultiAgentPresetSource;
  },
): AgentEntry | undefined {
  const delegatingAgents = implicitDefaultToolUseAgents(agents).filter(
    agentHasDelegationTools,
  );
  const preferredRoot = findPreferredRootAgent(
    delegatingAgents,
    options.presetSource,
    options.presetOrder,
  );
  if (preferredRoot) return preferredRoot;

  if (options.presetSource === 'built-in') {
    // Built-in teams have dedicated orchestrator roots. Local specialists such
    // as `lean`, `research`, or `numerics` are members, not safe root fallbacks.
    return undefined;
  }

  return delegatingAgents[0];
}

function findPreferredRootAgent(
  agents: readonly AgentEntry[],
  presetSource: CliMultiAgentPresetSource,
  presetOrder: readonly string[],
): AgentEntry | undefined {
  const searchOrder =
    presetSource === 'built-in'
      ? BUILT_IN_TEAM_ROOT_AGENT_NAMES
      : [...BUILT_IN_TEAM_ROOT_AGENT_NAMES, ...presetOrder];
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

function availablePresetTeamMemberCount(
  plan: CliMultiAgentPresetRunPlan,
): number {
  const rootKey = plan.rootAgent ? toAgentKey(plan.rootAgent) : undefined;
  const memberKeys = [
    ...plan.workflowAgentKeys,
    ...plan.toolUseAgentKeys.filter((key) => key !== rootKey),
  ];
  return new Set(memberKeys).size;
}

export function agentHasDelegationTools(agent: AgentEntry): boolean {
  return agent.tools?.some((tool) => DELEGATION_TOOLS.has(tool)) ?? false;
}

function toAgentKey(agent: AgentEntry): string {
  return agentKey(agent.source, agent.name);
}

function availablePresetAgents(
  presetAgents: readonly string[],
  missingAgents: readonly string[],
): string[] {
  const missing = new Set(missingAgents);
  return presetAgents.filter((agent) => !missing.has(agent));
}

function formatAvailablePresetAgentCount(
  presetAgents: readonly string[],
  missingAgents: readonly string[],
): string {
  return presetAgentAvailability(presetAgents, missingAgents).label;
}

function presetAgentAvailability(
  presetAgents: readonly string[],
  missingAgents: readonly string[],
): CliMultiAgentPresetAgentAvailability {
  const total = presetAgents.length;
  const available = total - missingAgents.length;
  return {
    available,
    total,
    missing: [...missingAgents],
    label: missingAgents.length === 0 ? String(total) : `${available}/${total}`,
  };
}

function formatPresetAvailabilityForLauncher(
  availability: CliMultiAgentPresetAvailability,
  blockReason: string | undefined,
): string | undefined {
  const details = blockReason ? [blockReason] : [];

  const countStyle = availability.status === 'available' ? 'total' : 'ratio';
  const parts = [
    formatPresetAgentCountForLauncher('tool-use', availability.toolUse, {
      countStyle,
    }),
    formatPresetAgentCountForLauncher('workflow', availability.workflow, {
      countStyle,
    }),
  ].filter((part): part is string => part != null);

  if (parts.length > 0) details.push(parts.join('; '));
  return details.length > 0 ? details.join('; ') : undefined;
}

function formatPresetAgentCountForLauncher(
  label: 'workflow' | 'tool-use',
  availability: CliMultiAgentPresetAgentAvailability,
  options: { readonly countStyle: 'total' | 'ratio' },
): string | undefined {
  if (availability.total === 0) return undefined;
  const agentText = availability.total === 1 ? 'agent' : 'agents';
  const count =
    options.countStyle === 'total'
      ? String(availability.total)
      : `${availability.available}/${availability.total}`;
  return `${count} ${label} ${agentText}`;
}

function formatAgentNames(names: readonly string[]): string {
  if (names.length === 0) return '  (none)';
  return names.map((name) => `  ${name}`).join('\n');
}

function cliMultiAgentPresetListHint(
  plans: readonly CliMultiAgentPresetRunPlan[],
  options: CliMultiAgentPresetFormatOptions,
): string | undefined {
  const hasIncompletePreset = plans.some(
    (plan) => cliMultiAgentPlanStatus(plan) !== 'available',
  );
  const hints = [
    hasIncompletePreset ? MULTI_AGENT_INSPECT_HINT : undefined,
    plans.some((plan) => shouldIncludeBuiltInLoginHint(plan, options))
      ? MULTI_AGENT_LOGIN_HINT
      : undefined,
  ].filter((hint): hint is string => hint !== undefined);
  return hints.length > 0 ? hints.join('\n') : undefined;
}

function shouldIncludeBuiltInLoginHint(
  plan: CliMultiAgentPresetRunPlan,
  options: CliMultiAgentPresetFormatOptions,
): boolean {
  return (options.includeLoginHint ?? true) && builtInPresetHasGaps(plan);
}

function builtInPresetHasGaps(plan: CliMultiAgentPresetRunPlan): boolean {
  return plan.preset.source === 'built-in' && cliMultiAgentPlanHasGaps(plan);
}

function lookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function slugKey(value: string): string {
  return lookupKey(value).replaceAll(/\s+/g, '-');
}
