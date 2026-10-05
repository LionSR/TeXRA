import { Array as Arr, Result } from 'effect';
import {
  AGENT_MODE_PRESETS,
  agentKeyOf,
  agentMatchesIdentifier,
  type AgentDelegationScope,
  type AgentSource,
  type TeamOptionData,
} from '@shared/schemas';
import {
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
  implicitDefaultToolUseAgents,
} from '@shared/constants/agents';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { capitalize } from '@utils/text/stringUtils';

import {
  findTeamPreset,
  launchableTeamPresets,
  type TeamPreset,
} from './TeamPresets';

export interface TeamCatalogAgent {
  readonly name: string;
  readonly source: AgentSource;
  readonly tools?: string[];
}

export interface TeamRunPlan<T extends TeamCatalogAgent = TeamCatalogAgent> {
  readonly preset: TeamPreset;
  readonly rootAgent?: T;
  readonly missingAgentOverride?: string;
  readonly agentKeys: readonly string[];
  /** Members that did not resolve, in preset-declaration order. */
  readonly missingAgents: readonly string[];
}

/**
 * The workspace agents' member identity rule (`getCatalogAgent` in
 * production): a bare name matches by name, a `source:name` key exactly.
 */
type TeamAgentResolver<T> = (identifier: string) => T | undefined;

interface TeamRunOptions<T extends TeamCatalogAgent> {
  readonly resolveAgent: TeamAgentResolver<T>;
  readonly agentOverride?: string;
}

export function planTeamRun<T extends TeamCatalogAgent>(
  preset: TeamPreset,
  options: TeamRunOptions<T>,
): TeamRunPlan<T> {
  const [members, missing] = Arr.partition(preset.agents, (name) =>
    Result.fromNullishOr(options.resolveAgent(name), () => name),
  );
  const overrideQuery = options.agentOverride?.trim();
  const overrideAgent = overrideQuery
    ? options.resolveAgent(overrideQuery)
    : undefined;
  const rootAgent =
    overrideAgent ??
    selectTeamRootAgent(members, {
      presetOrder: preset.agents,
      presetSource: preset.source,
    });
  // A preset-chosen root is one of the resolved members; only an override
  // root can sit outside the list, and it joins the delegation scope.
  const keys = members.map(agentKeyOf);
  const overrideKey = overrideAgent && agentKeyOf(overrideAgent);

  return {
    preset,
    rootAgent,
    missingAgentOverride:
      overrideQuery && !overrideAgent ? overrideQuery : undefined,
    agentKeys:
      overrideKey && !keys.includes(overrideKey)
        ? [...keys, overrideKey]
        : keys,
    missingAgents: missing,
  };
}

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
  if (!hasDelegationTool(plan.rootAgent.tools)) {
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

function buildTeamOptions(plans: readonly TeamRunPlan[]): TeamOptionData[] {
  const builtInOrder = new Map(
    AGENT_MODE_PRESETS.map((preset, index) => [preset.id, index]),
  );
  return plans
    .toSorted((left, right) => {
      if (left.preset.source !== right.preset.source) {
        return left.preset.source === 'built-in' ? -1 : 1;
      }
      if (left.preset.source === 'custom') {
        return left.preset.name.localeCompare(right.preset.name);
      }
      return (
        (builtInOrder.get(left.preset.id) ?? Number.MAX_SAFE_INTEGER) -
        (builtInOrder.get(right.preset.id) ?? Number.MAX_SAFE_INTEGER)
      );
    })
    .map((plan) => {
      const blockReason = teamLaunchBlockReason(plan);
      return {
        value: plan.preset.id,
        label: plan.preset.name,
        icon: plan.preset.icon,
        source: plan.preset.source,
        description: plan.preset.description,
        unavailableMembers: missingMemberNames(plan),
        disabled: blockReason ? true : undefined,
        disabledReason: blockReason
          ? formatTeamOptionDisabledReason(blockReason)
          : undefined,
      };
    });
}

export function loadTeamOptions<T extends TeamCatalogAgent>(ports: {
  customPresetsRaw: unknown;
  resolveAgent: TeamAgentResolver<T>;
}): TeamOptionData[] {
  const presets = launchableTeamPresets(ports.customPresetsRaw);
  return buildTeamOptions(
    planTeamRuns(presets, { resolveAgent: ports.resolveAgent }),
  );
}

type TeamLaunchResolution =
  | {
      readonly status: 'ready';
      readonly fields: ReturnType<typeof teamExecutionFields>;
      readonly missingNames: readonly string[];
    }
  | { readonly status: 'unknown-team' }
  | { readonly status: 'blocked'; readonly reason: string };

export function resolveTeamLaunch<T extends TeamCatalogAgent>(args: {
  teamId: string;
  customPresetsRaw: unknown;
  resolveAgent: TeamAgentResolver<T>;
}): TeamLaunchResolution {
  const preset = findTeamPreset(
    launchableTeamPresets(args.customPresetsRaw),
    args.teamId,
  );
  if (!preset) return { status: 'unknown-team' };

  const plan = planTeamRun(preset, { resolveAgent: args.resolveAgent });
  if (!canLaunchTeam(plan)) {
    return { status: 'blocked', reason: teamLaunchBlockReason(plan)! };
  }
  return {
    status: 'ready',
    fields: teamExecutionFields(plan),
    missingNames: missingMemberNames(plan),
  };
}

// ---------------------------------------------------------------------------
// Launch copy. Hosts render these strings through their own surfaces;
// keeping the literals here stops them drifting.
// ---------------------------------------------------------------------------

export const TEAM_SELECTION_REQUIRED_MESSAGE = 'Team selection required.';

export function formatUnknownTeamMessage(teamId: string): string {
  return `Unknown team "${teamId}".`;
}

export function formatTeamLaunchBlockedMessage(
  teamId: string,
  reason: string,
): string {
  return `Team "${teamId}" cannot run: ${reason}.`;
}

/** Missing member names, in preset-declaration order. */
export function missingMemberNames(
  plan: Pick<TeamRunPlan, 'missingAgents'>,
): string[] {
  return [...plan.missingAgents];
}

function selectTeamRootAgent<T extends TeamCatalogAgent>(
  agents: readonly T[],
  options: {
    readonly presetOrder: readonly string[];
    readonly presetSource: TeamPreset['source'];
  },
): T | undefined {
  const delegatingAgents = implicitDefaultToolUseAgents(agents).filter(
    (agent) => hasDelegationTool(agent.tools),
  );
  const searchOrder =
    options.presetSource === 'built-in'
      ? BUILTIN_TEAM_ROOT_AGENT_NAMES
      : [...options.presetOrder, ...BUILTIN_TEAM_ROOT_AGENT_NAMES];
  for (const identifier of searchOrder) {
    const preferredRoot = delegatingAgents.find((agent) =>
      agentMatchesIdentifier(agent, identifier),
    );
    if (preferredRoot) return preferredRoot;
  }
  return options.presetSource === 'built-in' ? undefined : delegatingAgents[0];
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
  return `${capitalize(reason)}.`;
}
