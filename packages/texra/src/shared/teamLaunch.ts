/**
 * Team launch: whether a planned team can run, how available it is, the
 * picker rows the hosts show for it, and the fields a launch carries. The
 * harness plans a team (`planTeamRun`); what the plan means to a person is
 * TeXRA's.
 */

// Third-party imports
import { String as Str } from 'effect';
import {
  findTeamPreset,
  planTeamRun,
  type AgentDelegationScope,
  type TeamCatalogAgent,
  type TeamPreset,
  type TeamRunOptions,
  type TeamRunPlan,
} from '@texra-ai/harness/host';
import { AGENT_TOOL_NAME } from '@texra-ai/harness/plugins';
import { agentKeyOf, type AgentSource } from '@texra-ai/harness/schemas';
import type { TeamOptionData } from '@texra/shared/pickerOptions';

export function planTeamRuns<T extends TeamCatalogAgent>(
  presets: readonly TeamPreset[],
  options: TeamRunOptions<T>,
): TeamRunPlan<T>[] {
  return presets.map((preset) => planTeamRun(preset, options));
}

function teamPlanHasGaps(plan: TeamRunPlan): boolean {
  return (
    !plan.rootAgent ||
    plan.missingAgentOverride !== undefined ||
    plan.missingAgents.length > 0
  );
}

export function teamLaunchBlockReason(plan: TeamRunPlan): string | undefined {
  if (!plan.rootAgent) return 'no runnable team root';
  if (!plan.rootAgent.tools?.includes(AGENT_TOOL_NAME)) {
    return `team root ${plan.rootAgent.name} is not a delegating agent`;
  }
  if (availableTeamMemberCount(plan) === 0) {
    return 'no available team members';
  }
  return undefined;
}

export function canLaunchTeam<T extends TeamCatalogAgent>(
  plan: TeamRunPlan<T>,
): plan is TeamRunPlan<T> & { readonly rootAgent: T } {
  return teamLaunchBlockReason(plan) === undefined;
}

type TeamPlanStatus = 'available' | 'degraded' | 'unavailable';

export function teamPlanStatus(plan: TeamRunPlan): TeamPlanStatus {
  if (teamLaunchBlockReason(plan)) return 'unavailable';
  return teamPlanHasGaps(plan) ? 'degraded' : 'available';
}

interface TeamAgentAvailability {
  readonly available: number;
  readonly total: number;
  readonly missing: readonly string[];
  readonly label: string;
}

export interface TeamAvailability {
  readonly status: TeamPlanStatus;
  readonly agents: TeamAgentAvailability;
  readonly rootAgent?: {
    readonly key: string;
    readonly name: string;
    readonly source: AgentSource;
  };
  readonly missingAgentOverride?: string;
}

export function teamAvailability(plan: TeamRunPlan): TeamAvailability {
  return {
    status: teamPlanStatus(plan),
    agents: presetAgentAvailability(plan.preset.agents, plan.missingAgents),
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

function teamExecutionFields<T extends TeamCatalogAgent>(
  plan: TeamRunPlan<T> & { readonly rootAgent: T },
): {
  agent: string;
  delegationAgentScope: AgentDelegationScope;
  cli: { teamId: string };
} {
  return {
    agent: agentKeyOf(plan.rootAgent),
    delegationAgentScope: [...plan.agentKeys],
    cli: { teamId: plan.preset.id },
  };
}

/** Built-in teams in catalog order, then custom teams by name. */
function buildTeamOptions(plans: readonly TeamRunPlan[]): TeamOptionData[] {
  return plans
    .toSorted((left, right) => {
      if (left.preset.source !== right.preset.source) {
        return left.preset.source === 'built-in' ? -1 : 1;
      }
      return left.preset.source === 'custom'
        ? left.preset.name.localeCompare(right.preset.name)
        : 0;
    })
    .map((plan) => {
      const blockReason = teamLaunchBlockReason(plan);
      return {
        value: plan.preset.id,
        label: plan.preset.name,
        icon: plan.preset.icon,
        source: plan.preset.source,
        description: plan.preset.description,
        unavailableMembers: [...plan.missingAgents],
        disabled: blockReason ? true : undefined,
        disabledReason: blockReason
          ? formatTeamOptionDisabledReason(blockReason)
          : undefined,
      };
    });
}

/** The catalog's launchable teams: every preset but the setup starter. */
const launchable = (presets: readonly TeamPreset[]): TeamPreset[] =>
  presets.filter((preset) => !preset.setupOnly);

export function loadTeamOptions<T extends TeamCatalogAgent>(
  ports: Omit<TeamRunOptions<T>, 'agentOverride'> & {
    presets: readonly TeamPreset[];
  },
): TeamOptionData[] {
  return buildTeamOptions(planTeamRuns(launchable(ports.presets), ports));
}

type TeamLaunchResolution =
  | {
      readonly status: 'ready';
      readonly fields: ReturnType<typeof teamExecutionFields>;
      readonly missingNames: readonly string[];
    }
  | { readonly status: 'unknown-team' }
  | { readonly status: 'blocked'; readonly reason: string };

export function resolveTeamLaunch<T extends TeamCatalogAgent>(
  args: Omit<TeamRunOptions<T>, 'agentOverride'> & {
    teamId: string;
    presets: readonly TeamPreset[];
  },
): TeamLaunchResolution {
  const preset = findTeamPreset(launchable(args.presets), args.teamId);
  if (!preset) return { status: 'unknown-team' };

  const plan = planTeamRun(preset, args);
  if (!canLaunchTeam(plan)) {
    return { status: 'blocked', reason: teamLaunchBlockReason(plan)! };
  }
  return {
    status: 'ready',
    fields: teamExecutionFields(plan),
    missingNames: plan.missingAgents,
  };
}

// ---------------------------------------------------------------------------
// Launch copy. Hosts render these strings through their own surfaces;
// keeping the literals here stops them drifting.
// ---------------------------------------------------------------------------

export function formatUnknownTeamMessage(teamId: string): string {
  return `Unknown team "${teamId}".`;
}

export function formatTeamLaunchBlockedMessage(
  teamId: string,
  reason: string,
): string {
  return `Team "${teamId}" cannot run: ${reason}.`;
}

/** Distinct member keys available to the run, excluding the root itself. */
export function availableTeamMemberCount(plan: TeamRunPlan): number {
  const rootKey = plan.rootAgent ? agentKeyOf(plan.rootAgent) : undefined;
  const memberKeys = plan.agentKeys.filter((key) => key !== rootKey);
  return new Set(memberKeys).size;
}

function presetAgentAvailability(
  presetAgents: readonly string[],
  missingAgents: readonly string[],
): TeamAgentAvailability {
  const total = presetAgents.length;
  const available = total - missingAgents.length;
  return {
    available,
    total,
    missing: [...missingAgents],
    label: missingAgents.length === 0 ? String(total) : `${available}/${total}`,
  };
}

function formatTeamOptionDisabledReason(reason: string): string {
  if (reason === 'no runnable team root') return 'No runnable team lead.';
  return `${Str.capitalize(reason)}.`;
}
