// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { AgentEntry } from '@agent/index';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  availableTeamMemberCount,
  teamAvailability,
  teamLaunchBlockReason,
  teamPlanStatus,
  type TeamAvailability,
  type TeamRunPlan,
} from '@common/teams/TeamPlan';
import {
  findTeamPreset,
  launchableTeamPresets,
  type TeamPreset,
} from '@common/teams/TeamPresets';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { formatResultCount } from '@utils/text/stringUtils';
import type { StateStore } from '@texra-ai/harness';

export type CliTeamRunPlan = TeamRunPlan<AgentEntry>;

interface CliTeamLaunchBlockMessageOptions {
  readonly requestedTeam?: string;
  readonly followUpAdvice?: string;
}

/**
 * Machine-readable `team list` record. It preserves the raw preset
 * fields so existing consumers still see a preset-shaped object, while adding
 * the planned availability that list output needs. (`team show` instead
 * loads the agent registry and emits the resolved run plan as
 * `team-inspection`.)
 */
interface CliTeamListRecord extends TeamPreset {
  readonly availability: TeamAvailability;
}

const MULTI_AGENT_TEAM_ROOT_AGENT_LABEL = 'Team root agent';
const MULTI_AGENT_SHOW_HINT =
  'Hint: run `texra team show <team-id>` to see missing agents for degraded or unavailable teams.';

/**
 * The team presets of the workspace whose state the caller holds: the built-in
 * teams plus whatever that project persisted. The store arrives as data from
 * the surface that opened it (a command's installed roots, the chat session's
 * roots) rather than being read off the calling context.
 */
export function readCliTeams(repoState: StateStore) {
  return Effect.gen(function* () {
    const customRaw = yield* repoState.get(WorkspaceStateKey.CUSTOM_TEAMS);
    return launchableTeamPresets(customRaw);
  });
}

/** Resolve the current display name for a persisted team identity. */
export function readCliTeamName(
  repoState: StateStore,
  teamId: string | undefined,
) {
  return Effect.gen(function* () {
    if (!teamId) return undefined;
    return findTeamPreset(yield* readCliTeams(repoState), teamId)?.name;
  });
}

function cliTeamAvailabilityParts(plan: CliTeamRunPlan): string[] {
  const availability = teamAvailability(plan);
  const parts =
    availability.agents.total === 0
      ? []
      : [`agents:${availability.agents.label}`];
  if (availability.status !== 'available') parts.push(availability.status);
  return parts;
}

export function formatCliTeamList(plans: readonly CliTeamRunPlan[]): string {
  if (plans.length === 0) return 'No teams found.';

  const rows = plans.map((plan) =>
    [
      plan.preset.source,
      plan.preset.id,
      plan.preset.name,
      ...cliTeamAvailabilityParts(plan),
    ].join('\t'),
  );

  return plans.some((plan) => teamPlanStatus(plan) !== 'available')
    ? [...rows, '', MULTI_AGENT_SHOW_HINT].join('\n')
    : rows.join('\n');
}

export function formatCliTeamInspection(plan: CliTeamRunPlan): string {
  const missing = new Set(plan.missingAgents);
  const availableAgents = plan.preset.agents.filter(
    (agent) => !missing.has(agent),
  );

  return [
    `${plan.preset.name} (${plan.preset.id})`,
    `Source: ${plan.preset.source}`,
    `Description: ${plan.preset.description}`,
    `${MULTI_AGENT_TEAM_ROOT_AGENT_LABEL}:`,
    `  ${plan.rootAgent?.name ?? '(none)'}`,
    'Available agents:',
    formatAgentNames(availableAgents),
    'Missing agents:',
    formatAgentNames(plan.missingAgents),
  ].join('\n');
}

export function cliTeamNdjsonRecords(
  plans: readonly CliTeamRunPlan[],
): CliNdjsonRecord[] {
  const ts = new Date().toISOString();
  return plans.map((plan) => ({
    kind: 'team',
    ts,
    preset: cliTeamListRecord(plan),
  }));
}

export function formatCliTeamLaunchBlockMessage(
  plan: CliTeamRunPlan,
  options: CliTeamLaunchBlockMessageOptions = {},
): string {
  const requested = options.requestedTeam ?? plan.preset.id;
  const reason = teamLaunchBlockReason(plan);
  if (!reason) {
    throw new Error(
      `Cannot format team launch block for launchable team "${plan.preset.id}".`,
    );
  }
  const parts = [
    `Team "${requested}" cannot start: ${reason}.`,
    `Run \`texra team show ${plan.preset.id}\` to see missing agents.`,
    options.followUpAdvice,
  ];
  return parts.filter((part): part is string => !!part).join(' ');
}

export function formatCliTeamRunWarnings(
  plan: CliTeamRunPlan,
): readonly string[] {
  if (plan.missingAgents.length === 0) return [];

  const warnings = [
    `WARN team ${plan.preset.id} references unavailable agents: ${plan.missingAgents.join(', ')}`,
  ];

  if (!plan.rootAgent || !hasDelegationTool(plan.rootAgent.tools)) {
    return warnings;
  }

  const availableTeamMembers = availableTeamMemberCount(plan);
  if (availableTeamMembers === 0) return warnings;

  warnings.push(
    `WARN team ${plan.preset.id} is degraded; running root agent ${plan.rootAgent.name} with ${formatResultCount(availableTeamMembers, 'available team agent')}.`,
  );
  return warnings;
}

export function cliTeamListRecord(plan: CliTeamRunPlan): CliTeamListRecord {
  return {
    ...plan.preset,
    availability: teamAvailability(plan),
  };
}

function formatAgentNames(names: readonly string[]): string {
  if (names.length === 0) return '  (none)';
  return names.map((name) => `  ${name}`).join('\n');
}
