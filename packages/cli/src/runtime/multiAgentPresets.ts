import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { platform } from '@platform/platform';
import {
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
  findAgentByIdentifier,
  type AgentEntry,
} from '@agent/index';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { teamHostedNamesForPreflight } from '@common/teams/TeamRoster';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { agentKeyOf } from '@shared/schemas/agent';
import {
  AGENT_MODE_PRESETS,
  parseAgentModePresets,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import { implicitDefaultToolUseAgents } from './defaultAgents';

type CliMultiAgentPresetSource = 'built-in' | 'custom';

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

type CliMultiAgentPlanStatus = 'available' | 'degraded' | 'unavailable';

interface CliMultiAgentPresetAgentAvailability {
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
 * the planned availability that list output needs. (`multi-agent show` instead
 * loads the agent registry and emits the resolved run plan as
 * `multi-agent-preset-inspection`.)
 */
export interface CliMultiAgentPresetListRecord extends CliMultiAgentPreset {
  readonly availability: CliMultiAgentPresetAvailability;
}

const MULTI_AGENT_TEAM_ROOT_AGENT_LABEL = 'Team root agent';
export const MULTI_AGENT_TEAM_ROOT_AGENT_DESCRIPTION =
  'Root agent for the team run (defaults to the preset orchestrator)';
export const MULTI_AGENT_TEAM_ROOT_MODEL_DESCRIPTION =
  'Model for the team root agent';
const MULTI_AGENT_SHOW_HINT =
  'Hint: run `texra multi-agent show <team-id>` to see missing agents for degraded or unavailable presets.';
const MULTI_AGENT_LOGIN_HINT =
  'Hint: Researcher Access sign-in may load additional remote team agents.';
const MULTI_AGENT_NO_TEAM_ROOT_REASON = 'no runnable team root';
const MULTI_AGENT_LAUNCHER_SHOW_HINT =
  'Team setup: run `texra multi-agent show <team-id>` using the team id shown in each row.';
const MULTI_AGENT_LAUNCHER_LOGIN_HINT =
  'Researcher Access sign-in may unlock more remote team agents.';
const MULTI_AGENT_LAUNCHER_NO_TEAM_ROOT_REASON = 'no team root';

function formatCliMultiAgentShowCommand(preset: string): string {
  return `texra multi-agent show ${preset}`;
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
    ...parseAgentModePresets(customRaw).map((preset) => ({
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

function cliMultiAgentPresetAvailabilityParts(
  plan: CliMultiAgentPresetRunPlan,
): string[] {
  const availability = cliMultiAgentPresetAvailability(plan);
  const parts = [
    formatCliMultiAgentPresetAvailabilityPart(
      'workflow',
      availability.workflow,
    ),
    formatCliMultiAgentPresetAvailabilityPart('tool-use', availability.toolUse),
  ].filter((part): part is string => part != null);
  if (availability.status !== 'available') parts.push(availability.status);
  return parts;
}

function formatCliMultiAgentPresetAvailabilityPart(
  kind: 'workflow' | 'tool-use',
  availability: CliMultiAgentPresetAgentAvailability,
): string | undefined {
  if (availability.total === 0) return undefined;
  return `${kind}:${availability.label}`;
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
  if (cliMultiAgentPresetShouldIncludeLoginHint(plan, options)) {
    lines.push('', MULTI_AGENT_LOGIN_HINT);
  }
  return lines.join('\n');
}

export function cliMultiAgentPresetNdjsonRecords(
  plans: readonly CliMultiAgentPresetRunPlan[],
): CliNdjsonRecord[] {
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

/** TeXRA-hosted definitions missing from this plan, independent of models. */
export function cliMultiAgentTexraHostedMissingNames(
  plan: CliMultiAgentPresetRunPlan,
): string[] {
  const missing = [...plan.missingWorkflowAgents, ...plan.missingToolUseAgents];
  const hosted = teamHostedNamesForPreflight(plan.preset, missing);
  return missing.filter((name) => hosted.has(name));
}

function cliMultiAgentPlanStatus(
  plan: CliMultiAgentPresetRunPlan,
): CliMultiAgentPlanStatus {
  if (cliMultiAgentPresetTeamLaunchBlockReason(plan)) return 'unavailable';
  return cliMultiAgentPlanHasGaps(plan) ? 'degraded' : 'available';
}

export function cliMultiAgentPresetTeamLaunchBlockReason(
  plan: CliMultiAgentPresetRunPlan,
): string | undefined {
  if (!plan.rootAgent) return MULTI_AGENT_NO_TEAM_ROOT_REASON;
  if (!agentHasDelegationTools(plan.rootAgent)) {
    return `team root ${plan.rootAgent.name} is not a delegating agent`;
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
    `Run \`${formatCliMultiAgentShowCommand(plan.preset.id)}\` to see missing agents.`,
    options.followUpAdvice,
  ];
  return parts.filter((part): part is string => !!part).join(' ');
}

export function formatCliMultiAgentPresetRunWarnings(
  plan: CliMultiAgentPresetRunPlan,
): readonly string[] {
  const missing = [
    ...plan.missingWorkflowAgents.map((agent) => `workflow:${agent}`),
    ...plan.missingToolUseAgents.map((agent) => `tool-use:${agent}`),
  ];
  if (missing.length === 0) return [];

  const warnings = [
    `WARN preset ${plan.preset.id} references unavailable agents: ${missing.join(', ')}`,
  ];

  if (!plan.rootAgent || !agentHasDelegationTools(plan.rootAgent)) {
    return warnings;
  }

  const availableTeamMembers = availablePresetTeamMemberCount(plan);
  if (availableTeamMembers === 0) return warnings;

  warnings.push(
    `WARN preset ${plan.preset.id} is degraded; running root agent ${plan.rootAgent.name} with ${formatAvailableTeamAgentCount(availableTeamMembers)}.`,
  );
  return warnings;
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
  const availability = cliMultiAgentPresetAvailability(plan);
  return [
    availability.status !== 'available'
      ? MULTI_AGENT_LAUNCHER_SHOW_HINT
      : undefined,
    cliMultiAgentPresetShouldIncludeLoginHint(plan, options)
      ? MULTI_AGENT_LAUNCHER_LOGIN_HINT
      : undefined,
  ].filter((hint): hint is string => hint !== undefined);
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
          key: agentKeyOf(plan.rootAgent),
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
    workflowAgentKeys: workflow.resolved.map(agentKeyOf),
    toolUseAgentKeys: toolUseAgents.map(agentKeyOf),
    missingWorkflowAgents: workflow.missing,
    missingToolUseAgents: toolUse.missing,
  };
}

export async function withCliMultiAgentPresetVisibility<T>(
  plan: CliMultiAgentPresetRunPlan,
  operation: () => Promise<T>,
): Promise<T> {
  const { lifecycle, workspaceState } = platform();
  const previousWorkflowAgents = workspaceState.get<string[] | undefined>(
    WorkspaceStateKey.ENABLED_AGENTS,
  );
  const previousToolUseAgents = workspaceState.get<string[] | undefined>(
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
  );

  const visibilityApplied = (async () => {
    await workspaceState.update(WorkspaceStateKey.ENABLED_AGENTS, [
      ...plan.workflowAgentKeys,
    ]);
    await workspaceState.update(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS, [
      ...plan.toolUseAgentKeys,
    ]);
  })();
  let restorePromise: Promise<void> | undefined;
  const restoreVisibility = (): Promise<void> => {
    restorePromise ??= (async () => {
      // A partial apply still needs rollback; the original error continues from the try block.
      await visibilityApplied.catch(() => undefined);
      await workspaceState.update(
        WorkspaceStateKey.ENABLED_AGENTS,
        previousWorkflowAgents,
      );
      await workspaceState.update(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        previousToolUseAgents,
      );
    })();
    return restorePromise;
  };
  const shutdownRestore = lifecycle.onShutdown(
    SHUTDOWN_PHASE.BEFORE,
    restoreVisibility,
  );

  try {
    await visibilityApplied;
    return await operation();
  } finally {
    try {
      await restoreVisibility();
    } finally {
      shutdownRestore.dispose();
    }
  }
}

function resolvePresetAgents(
  names: readonly string[],
  agents: readonly AgentEntry[],
): { resolved: AgentEntry[]; missing: string[] } {
  const resolved: AgentEntry[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const entry = findAgentByIdentifier(agents, name);
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
  // Accepts a bare name or a source-qualified key via the registry's canonical
  // identity matcher, instead of re-implementing the name-or-key rule here.
  const agent = findAgentByIdentifier(agents, query);
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
  const searchOrder =
    options.presetSource === 'built-in'
      ? BUILTIN_TEAM_ROOT_AGENT_NAMES
      : [...options.presetOrder, ...BUILTIN_TEAM_ROOT_AGENT_NAMES];
  for (const name of searchOrder) {
    const preferredRoot = delegatingAgents.find((agent) => agent.name === name);
    if (preferredRoot) return preferredRoot;
  }

  if (options.presetSource === 'built-in') {
    // Built-in teams have dedicated orchestrator roots. Local specialists such
    // as `lean`, `research`, or `numerics` are members, not safe root fallbacks.
    return undefined;
  }

  return delegatingAgents[0];
}

function includeAgent(
  agents: readonly AgentEntry[],
  rootAgent: AgentEntry,
): AgentEntry[] {
  const rootKey = agentKeyOf(rootAgent);
  return agents.some((agent) => agentKeyOf(agent) === rootKey)
    ? [...agents]
    : [...agents, rootAgent];
}

function availablePresetTeamMemberCount(
  plan: CliMultiAgentPresetRunPlan,
): number {
  const rootKey = plan.rootAgent ? agentKeyOf(plan.rootAgent) : undefined;
  const memberKeys = [
    ...plan.workflowAgentKeys,
    ...plan.toolUseAgentKeys.filter((key) => key !== rootKey),
  ];
  return new Set(memberKeys).size;
}

function formatAvailableTeamAgentCount(count: number): string {
  return count === 1
    ? '1 available team agent'
    : `${count} available team agents`;
}

function formatPresetAvailabilityForLauncher(
  availability: CliMultiAgentPresetAvailability,
  blockReason: string | undefined,
): string | undefined {
  const details = blockReason ? [formatLauncherBlockReason(blockReason)] : [];
  const countStyle = availability.status === 'available' ? 'total' : 'ratio';
  const parts = [
    formatPresetAgentCountForLauncher('workflow', availability.workflow, {
      countStyle,
    }),
    formatPresetAgentCountForLauncher('tool-use', availability.toolUse, {
      countStyle,
    }),
  ].filter((part): part is string => part != null);

  if (parts.length > 0) details.push(parts.join('; '));
  return details.length > 0 ? details.join('; ') : undefined;
}

function formatLauncherBlockReason(blockReason: string): string {
  return blockReason === MULTI_AGENT_NO_TEAM_ROOT_REASON
    ? MULTI_AGENT_LAUNCHER_NO_TEAM_ROOT_REASON
    : blockReason;
}

function formatPresetAgentCountForLauncher(
  kind: 'workflow' | 'tool-use',
  availability: CliMultiAgentPresetAgentAvailability,
  options: { readonly countStyle: 'total' | 'ratio' },
): string | undefined {
  if (availability.total === 0) return undefined;
  const count =
    options.countStyle === 'total'
      ? String(availability.total)
      : `${availability.available}/${availability.total}`;
  return `${count} ${launcherAgentKindLabel(kind, availability.total)}`;
}

function launcherAgentKindLabel(
  kind: 'workflow' | 'tool-use',
  count: number,
): string {
  if (kind === 'tool-use') return count === 1 ? 'tool' : 'tools';
  return count === 1 ? 'workflow' : 'workflows';
}

function agentHasDelegationTools(agent: AgentEntry): boolean {
  return hasDelegationTool(agent.tools);
}

function availablePresetAgents(
  presetAgents: readonly string[],
  missingAgents: readonly string[],
): string[] {
  const missing = new Set(missingAgents);
  return presetAgents.filter((agent) => !missing.has(agent));
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
    hasIncompletePreset ? MULTI_AGENT_SHOW_HINT : undefined,
    plans.some((plan) =>
      cliMultiAgentPresetShouldIncludeLoginHint(plan, options),
    )
      ? MULTI_AGENT_LOGIN_HINT
      : undefined,
  ].filter((hint): hint is string => hint !== undefined);
  return hints.length > 0 ? hints.join('\n') : undefined;
}

function cliMultiAgentPresetShouldIncludeLoginHint(
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
