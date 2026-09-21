import type { AgentEntry } from '@agent/index';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  availableTeamMemberCount,
  findTeamPreset,
  teamAvailability,
  teamLaunchBlockReason,
  teamPlanHasGaps,
  teamPlanStatus,
  teamPresets,
  type TeamAgentAvailability,
  type TeamAvailability,
  type TeamPreset,
  type TeamRunPlan,
} from '@common/teams/TeamPlan';
import type { StateStore } from '@platform/interfaces';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { RESEARCHER_ACCESS } from '@ui/copy/onboarding';
import { filterNotNullish } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

export type CliMultiAgentPresetRunPlan = TeamRunPlan<AgentEntry>;

interface CliMultiAgentPresetFormatOptions {
  readonly includeLoginHint?: boolean;
}

interface CliMultiAgentTeamLaunchBlockMessageOptions {
  readonly requestedPreset?: string;
  readonly followUpAdvice?: string;
}

/**
 * Machine-readable `multi-agent list` record. It preserves the raw preset
 * fields so existing consumers still see a preset-shaped object, while adding
 * the planned availability that list output needs. (`multi-agent show` instead
 * loads the agent registry and emits the resolved run plan as
 * `multi-agent-preset-inspection`.)
 */
interface CliMultiAgentPresetListRecord extends TeamPreset {
  readonly availability: TeamAvailability;
}

const MULTI_AGENT_TEAM_ROOT_AGENT_LABEL = 'Team root agent';
const MULTI_AGENT_SHOW_HINT =
  'Hint: run `texra multi-agent show <team-id>` to see missing agents for degraded or unavailable presets.';
const MULTI_AGENT_LOGIN_HINT = `Hint: ${RESEARCHER_ACCESS.label} sign-in may load additional remote team agents.`;

/**
 * The team presets of the workspace whose state the caller holds: the built-in
 * teams plus whatever that project persisted. The store arrives as data from
 * the surface that opened it (a command's installed roots, the chat session's
 * roots) rather than being read off the calling context.
 */
export function readCliMultiAgentPresets(
  workspaceState: StateStore,
): TeamPreset[] {
  const customRaw = workspaceState.get<unknown>(
    WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
  );
  return teamPresets(customRaw);
}

/** Resolve the current display name for a persisted team identity. */
export function readCliMultiAgentPresetName(
  workspaceState: StateStore,
  presetId: string | undefined,
): string | undefined {
  if (!presetId) return undefined;
  return findTeamPreset(readCliMultiAgentPresets(workspaceState), presetId)
    ?.name;
}

function cliMultiAgentPresetAvailabilityParts(
  plan: CliMultiAgentPresetRunPlan,
): string[] {
  const availability = teamAvailability(plan);
  const parts = [
    formatCliMultiAgentPresetAvailabilityPart(
      'workflow',
      availability.agents.workflow,
    ),
    formatCliMultiAgentPresetAvailabilityPart(
      'tool-use',
      availability.agents.toolUse,
    ),
  ].filter(filterNotNullish);
  if (availability.status !== 'available') parts.push(availability.status);
  return parts;
}

function formatCliMultiAgentPresetAvailabilityPart(
  kind: 'workflow' | 'tool-use',
  availability: TeamAgentAvailability,
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
    plan.preset.agents.workflow,
    plan.missingAgents.workflow,
  );
  const availableToolUseAgents = availablePresetAgents(
    plan.preset.agents.toolUse,
    plan.missingAgents.toolUse,
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
    formatAgentNames(plan.missingAgents.workflow),
    'Missing tool-use agents:',
    formatAgentNames(plan.missingAgents.toolUse),
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

export function formatCliMultiAgentTeamLaunchBlockMessage(
  plan: CliMultiAgentPresetRunPlan,
  options: CliMultiAgentTeamLaunchBlockMessageOptions = {},
): string {
  const preset = options.requestedPreset ?? plan.preset.id;
  const reason = teamLaunchBlockReason(plan);
  if (!reason) {
    throw new Error(
      `Cannot format team launch block for launchable multi-agent preset "${plan.preset.id}".`,
    );
  }
  const parts = [
    `Multi-agent preset "${preset}" cannot start as a team: ${reason}.`,
    `Run \`texra multi-agent show ${plan.preset.id}\` to see missing agents.`,
    options.followUpAdvice,
  ];
  return parts.filter((part): part is string => !!part).join(' ');
}

export function formatCliMultiAgentPresetRunWarnings(
  plan: CliMultiAgentPresetRunPlan,
): readonly string[] {
  const missing = [
    ...plan.missingAgents.workflow.map((agent) => `workflow:${agent}`),
    ...plan.missingAgents.toolUse.map((agent) => `tool-use:${agent}`),
  ];
  if (missing.length === 0) return [];

  const warnings = [
    `WARN preset ${plan.preset.id} references unavailable agents: ${missing.join(', ')}`,
  ];

  if (!plan.rootAgent || !hasDelegationTool(plan.rootAgent.tools)) {
    return warnings;
  }

  const availableTeamMembers = availableTeamMemberCount(plan);
  if (availableTeamMembers === 0) return warnings;

  warnings.push(
    `WARN preset ${plan.preset.id} is degraded; running root agent ${plan.rootAgent.name} with ${formatResultCount(availableTeamMembers, 'available team agent')}.`,
  );
  return warnings;
}

export function cliMultiAgentPresetListRecord(
  plan: CliMultiAgentPresetRunPlan,
): CliMultiAgentPresetListRecord {
  return {
    ...plan.preset,
    availability: teamAvailability(plan),
  };
}

function availablePresetAgents(
  presetAgents: readonly string[],
  missingAgents: readonly string[],
): string[] {
  const missing = new Set(missingAgents);
  return presetAgents.filter((agent) => !missing.has(agent));
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
    (plan) => teamPlanStatus(plan) !== 'available',
  );
  const hints = [
    hasIncompletePreset ? MULTI_AGENT_SHOW_HINT : undefined,
    plans.some((plan) =>
      cliMultiAgentPresetShouldIncludeLoginHint(plan, options),
    )
      ? MULTI_AGENT_LOGIN_HINT
      : undefined,
  ].filter(filterNotNullish);
  return hints.length > 0 ? hints.join('\n') : undefined;
}

function cliMultiAgentPresetShouldIncludeLoginHint(
  plan: CliMultiAgentPresetRunPlan,
  options: CliMultiAgentPresetFormatOptions,
): boolean {
  return (
    (options.includeLoginHint ?? true) &&
    plan.preset.source === 'built-in' &&
    teamPlanHasGaps(plan)
  );
}
