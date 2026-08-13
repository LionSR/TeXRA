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
import { platform } from '@platform/platform';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { filterNotNullish } from '@utils/core';
import { formatResultCount, pluralize } from '@utils/text/stringUtils';

export type CliMultiAgentPreset = TeamPreset;
export type CliMultiAgentPresetRunPlan = TeamRunPlan<AgentEntry>;

interface CliMultiAgentPresetFormatOptions {
  readonly includeLoginHint?: boolean;
}

interface CliMultiAgentTeamLaunchBlockMessageOptions {
  readonly requestedPreset?: string;
  readonly followUpAdvice?: string;
}

type CliMultiAgentPresetAgentAvailability = TeamAgentAvailability;

type CliMultiAgentPresetAvailability = TeamAvailability;

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

export function readCliMultiAgentPresets(): CliMultiAgentPreset[] {
  const customRaw = platform().workspaceState.get<unknown>(
    WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
  );
  return teamPresets(customRaw);
}

/** Resolve the current display name for a persisted team identity. */
export function readCliMultiAgentPresetName(
  presetId: string | undefined,
): string | undefined {
  if (!presetId) return undefined;
  return findTeamPreset(readCliMultiAgentPresets(), presetId)?.name;
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

export function formatCliMultiAgentPresetLauncherSummary(
  plan: CliMultiAgentPresetRunPlan,
): string {
  const availability = teamAvailability(plan);
  const status =
    availability.status === 'available' ? 'ready' : availability.status;
  const details = formatPresetAvailabilityForLauncher(
    availability,
    teamLaunchBlockReason(plan),
  );

  return [status, details].filter(filterNotNullish).join('; ');
}

export function formatCliMultiAgentPresetLauncherHints(
  plan: CliMultiAgentPresetRunPlan,
  options: CliMultiAgentPresetFormatOptions = {},
): readonly string[] {
  const availability = teamAvailability(plan);
  return [
    availability.status !== 'available'
      ? MULTI_AGENT_LAUNCHER_SHOW_HINT
      : undefined,
    cliMultiAgentPresetShouldIncludeLoginHint(plan, options)
      ? MULTI_AGENT_LAUNCHER_LOGIN_HINT
      : undefined,
  ].filter(filterNotNullish);
}

export function cliMultiAgentPresetListRecord(
  plan: CliMultiAgentPresetRunPlan,
): CliMultiAgentPresetListRecord {
  return {
    ...plan.preset,
    availability: teamAvailability(plan),
  };
}

export function cliMultiAgentPresetListRecords(
  plans: readonly CliMultiAgentPresetRunPlan[],
): CliMultiAgentPresetListRecord[] {
  return plans.map(cliMultiAgentPresetListRecord);
}

function formatPresetAvailabilityForLauncher(
  availability: CliMultiAgentPresetAvailability,
  blockReason: string | undefined,
): string | undefined {
  const details = blockReason ? [formatLauncherBlockReason(blockReason)] : [];
  const countStyle = availability.status === 'available' ? 'total' : 'ratio';
  const parts = [
    formatPresetAgentCountForLauncher(
      'workflow',
      availability.agents.workflow,
      {
        countStyle,
      },
    ),
    formatPresetAgentCountForLauncher('tool-use', availability.agents.toolUse, {
      countStyle,
    }),
  ].filter(filterNotNullish);

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
  const label = pluralize(
    availability.total,
    kind === 'tool-use' ? 'tool' : 'workflow',
  );
  return `${count} ${label}`;
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
