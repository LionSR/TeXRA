import { Effect } from 'effect';
import type { SignInFailed } from '@common/errors/signInFailed';
import {
  AGENT_CATEGORIES,
  AGENT_MODE_PRESETS,
  AgentCategory,
  agentKeyOf,
  agentMatchesIdentifier,
  byCategory,
  type AgentDelegationScope,
  type AgentSource,
  type ByCategory,
  type TeamOptionData,
} from '@shared/schemas';
import {
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
  implicitDefaultToolUseAgents,
} from '@shared/constants/agents';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { capitalize } from '@utils/text/stringUtils';

import {
  preflightTeamAvailability,
  type TeamAvailabilityChoice,
  type TeamCatalogPortFailed,
} from './TeamAvailabilityPreflight';
import {
  findTeamPreset,
  launchableTeamPresets,
  type TeamPreset,
} from './TeamPresets';
import { resolvePresetAgents } from './TeamRoster';

export interface TeamCatalogAgent {
  readonly name: string;
  readonly source: AgentSource;
  readonly tools?: string[];
}

export interface TeamRunPlan<T extends TeamCatalogAgent = TeamCatalogAgent> {
  readonly preset: TeamPreset;
  readonly rootAgent?: T;
  readonly missingAgentOverride?: string;
  readonly agentKeys: ByCategory<readonly string[]>;
  readonly missingAgents: ByCategory<readonly string[]>;
}

/**
 * The roster's member identity rule (`getCategoryAgent` in production): a bare
 * name matches within the category, a `source:name` key matches exactly.
 */
type TeamAgentResolver<T> = (
  category: AgentCategory,
  identifier: string,
) => T | undefined;

interface TeamRunOptions<T extends TeamCatalogAgent> {
  readonly resolveAgent: TeamAgentResolver<T>;
  readonly agentOverride?: string;
}

export function planTeamRun<T extends TeamCatalogAgent>(
  preset: TeamPreset,
  options: TeamRunOptions<T>,
): TeamRunPlan<T> {
  const resolved = byCategory((category) =>
    resolvePresetAgents(preset.agents[category], (name) =>
      options.resolveAgent(category, name),
    ),
  );
  const overrideQuery = options.agentOverride?.trim();
  const overrideAgent = overrideQuery
    ? options.resolveAgent(AgentCategory.ToolUse, overrideQuery)
    : undefined;
  const rootAgent =
    overrideAgent ??
    selectTeamRootAgent(resolved.toolUse.resolved, {
      presetOrder: preset.agents.toolUse,
      presetSource: preset.source,
    });
  const toolUseAgents = rootAgent
    ? includeAgent(resolved.toolUse.resolved, rootAgent)
    : resolved.toolUse.resolved;

  return {
    preset,
    rootAgent,
    missingAgentOverride:
      overrideQuery && !overrideAgent ? overrideQuery : undefined,
    agentKeys: {
      workflow: resolved.workflow.resolved.map(agentKeyOf),
      toolUse: toolUseAgents.map(agentKeyOf),
    },
    missingAgents: byCategory((category) => resolved[category].missing),
  };
}

export function planTeamRuns<T extends TeamCatalogAgent>(
  presets: readonly TeamPreset[],
  options: TeamRunOptions<T>,
): TeamRunPlan<T>[] {
  return presets.map((preset) => planTeamRun(preset, options));
}

export function teamPlanHasGaps(plan: TeamRunPlan): boolean {
  return (
    !plan.rootAgent ||
    plan.missingAgentOverride !== undefined ||
    AGENT_CATEGORIES.some((category) => plan.missingAgents[category].length > 0)
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

export type TeamPlanStatus = 'available' | 'degraded' | 'unavailable';

export function teamPlanStatus(plan: TeamRunPlan): TeamPlanStatus {
  if (teamLaunchBlockReason(plan)) return 'unavailable';
  return teamPlanHasGaps(plan) ? 'degraded' : 'available';
}

export interface TeamAgentAvailability {
  readonly available: number;
  readonly total: number;
  readonly missing: readonly string[];
  readonly label: string;
}

export interface TeamAvailability {
  readonly status: TeamPlanStatus;
  readonly agents: ByCategory<TeamAgentAvailability>;
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
    agents: byCategory((category) =>
      presetAgentAvailability(
        plan.preset.agents[category],
        plan.missingAgents[category],
      ),
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

function teamExecutionFields<T extends TeamCatalogAgent>(
  plan: TeamRunPlan<T> & { readonly rootAgent: T },
): {
  agent: string;
  delegationAgentScope: AgentDelegationScope;
  cli: { multiAgentPresetId: string };
} {
  return {
    agent: agentKeyOf(plan.rootAgent),
    delegationAgentScope: byCategory((category) => [
      ...plan.agentKeys[category],
    ]),
    cli: { multiAgentPresetId: plan.preset.id },
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

export function loadTeamOptions<T extends TeamCatalogAgent, R = never>(ports: {
  customPresetsRaw: unknown;
  ensureCatalogLoaded: () => Effect.Effect<void, Error, R>;
  resolveAgent: TeamAgentResolver<T>;
  canAccessRemoteCatalog: () => Effect.Effect<boolean>;
  refreshRemote: () => Effect.Effect<void, Error, R>;
}): Effect.Effect<TeamOptionData[], Error, R> {
  return Effect.gen(function* () {
    yield* ports.ensureCatalogLoaded();
    const presets = launchableTeamPresets(ports.customPresetsRaw);
    const planCurrent = () =>
      planTeamRuns(presets, { resolveAgent: ports.resolveAgent });
    const result = yield* refreshRemoteCatalogForGaps(
      planCurrent(),
      (plans) => plans.some(teamPlanHasGaps),
      planCurrent,
      ports,
    );
    return buildTeamOptions(result.value);
  });
}

export type TeamLaunchResolution =
  | {
      readonly status: 'ready';
      readonly fields: ReturnType<typeof teamExecutionFields>;
      /**
       * Reflects ONLY TeXRA-hosted member gaps skipped after a preflight
       * 'continue' choice. Non-hosted missing members populate
       * `missingNames` but leave `partial: false` and never trigger the
       * preflight dialog, because only hosted members can potentially be
       * resolved via sign-in/refresh.
       */
      readonly partial: boolean;
      readonly missingNames: readonly string[];
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unknown-team' }
  | { readonly status: 'blocked'; readonly reason: string }
  | {
      readonly status: 'unavailable';
      readonly unavailableNames: readonly string[];
    };

export function resolveTeamLaunch<T extends TeamCatalogAgent, R = never>(args: {
  teamId: string;
  customPresetsRaw: unknown;
  ensureCatalogLoaded: () => Effect.Effect<void, Error, R>;
  resolveAgent: TeamAgentResolver<T>;
  canAccessRemoteCatalog: () => Effect.Effect<boolean>;
  refreshRemote: () => Effect.Effect<void, Error, R>;
  choose: (
    unavailableNames: readonly string[],
  ) => Effect.Effect<TeamAvailabilityChoice | undefined, TeamCatalogPortFailed>;
  signIn: () => Effect.Effect<boolean, SignInFailed>;
  providedChoice?: TeamAvailabilityChoice;
}): Effect.Effect<TeamLaunchResolution, Error, R> {
  return Effect.gen(function* () {
    const preset = findTeamPreset(
      launchableTeamPresets(args.customPresetsRaw),
      args.teamId,
    );
    if (!preset) return { status: 'unknown-team' as const };

    yield* args.ensureCatalogLoaded();
    const planCurrent = () =>
      planTeamRun(preset, { resolveAgent: args.resolveAgent });
    const refreshed = yield* refreshRemoteCatalogForGaps(
      planCurrent(),
      teamPlanHasGaps,
      planCurrent,
      args,
    );
    const preflight = yield* preflightTeamAvailability({
      initial: refreshed.value,
      // The preflight owns the hosted-member filter; hand it the raw gaps.
      unresolvedNames: missingMemberNames,
      texraHostedNames: new Set(preset.texraHostedAgents),
      canAccessRemoteCatalog: args.canAccessRemoteCatalog,
      providedChoice: args.providedChoice,
      choose: args.choose,
      signIn: args.signIn,
      refreshRemote: args.refreshRemote,
      replan: () => Effect.sync(planCurrent),
      remoteCatalogRefreshAttempted: refreshed.remoteCatalogRefreshAttempted,
    });

    // 'choice-required' is reachable only when no provided choice exists and the
    // interactive choice port returns no decision; hosts treat dismissal as cancel.
    if (
      preflight.status === 'cancelled' ||
      preflight.status === 'choice-required'
    ) {
      return { status: 'cancelled' as const };
    }
    if (preflight.status === 'unavailable') {
      return {
        status: 'unavailable' as const,
        unavailableNames: preflight.unavailableNames,
      };
    }

    const plan = preflight.value;
    if (!canLaunchTeam(plan)) {
      return {
        status: 'blocked' as const,
        reason: teamLaunchBlockReason(plan)!,
      };
    }
    return {
      status: 'ready' as const,
      fields: teamExecutionFields(plan),
      partial: preflight.partial,
      missingNames: missingMemberNames(plan),
    };
  });
}

export function refreshRemoteCatalogForGaps<T, R = never>(
  value: T,
  hasGaps: (value: T) => boolean,
  replan: () => T,
  ports: {
    canAccessRemoteCatalog: () => Effect.Effect<boolean>;
    refreshRemote: () => Effect.Effect<void, Error, R>;
  },
): Effect.Effect<
  { value: T; remoteCatalogRefreshAttempted: boolean },
  Error,
  R
> {
  return Effect.gen(function* () {
    // `hasGaps` first, as in the Promise original: a gapless plan must not
    // even probe remote access.
    if (hasGaps(value)) {
      const canAccess = yield* ports.canAccessRemoteCatalog();
      if (canAccess) {
        yield* ports.refreshRemote();
        return { value: replan(), remoteCatalogRefreshAttempted: true };
      }
    }
    return { value, remoteCatalogRefreshAttempted: false };
  });
}

// ---------------------------------------------------------------------------
// Launch dialog copy. Hosts render these strings through their own dialogs
// (VS Code vs Electron native); keeping the literals here stops them drifting.
// ---------------------------------------------------------------------------

/** Host-neutral unavailable-members prompt, including action order. */
export interface TeamAvailabilityPrompt {
  readonly severity: 'warning';
  readonly message: string;
  readonly actions: readonly [
    { readonly choice: 'sign-in'; readonly label: string },
    { readonly choice: 'continue'; readonly label: string },
    { readonly choice: 'cancel'; readonly label: string },
  ];
}

/** Build the unavailable-member prompt shared by launch and settings flows. */
export function teamAvailabilityPrompt(
  unavailableNames: readonly string[],
  teamId?: string,
): TeamAvailabilityPrompt {
  return {
    severity: 'warning',
    message: formatUnavailableTeamMembersMessage(unavailableNames, teamId),
    actions: [
      { choice: 'sign-in', label: 'Sign In to TeXRA' },
      { choice: 'continue', label: 'Continue with Available Members' },
      { choice: 'cancel', label: 'Cancel' },
    ],
  };
}

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

export function formatTeamUnavailableMessage(
  teamId: string,
  unavailableNames: readonly string[],
): string {
  return `Team "${teamId}" is unavailable: ${unavailableNames.join(', ')}.`;
}

/**
 * Prompt shown before launching a team that has unavailable hosted members.
 *
 * `teamId` is optional because the two hosts reach this prompt with different
 * context: the main-view launch path already displays the team being launched,
 * while the settings path names it inline.
 */
function formatUnavailableTeamMembersMessage(
  unavailableNames: readonly string[],
  teamId?: string,
): string {
  const subject = teamId === undefined ? 'This team' : `Team "${teamId}"`;
  return `${subject} has unavailable TeXRA-hosted members: ${unavailableNames.join(', ')}.`;
}

export function formatPartialTeamLaunchMessage(
  missingNames: readonly string[],
): string {
  return `This team will run with available members only. Unavailable members: ${missingNames.join(', ')}.`;
}

/** Missing workflow and tool-use member names, in preset-declaration order. */
function missingMemberNames(plan: TeamRunPlan): string[] {
  return AGENT_CATEGORIES.flatMap((category) => plan.missingAgents[category]);
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

function includeAgent<T extends TeamCatalogAgent>(
  agents: readonly T[],
  rootAgent: T,
): T[] {
  const rootKey = agentKeyOf(rootAgent);
  return agents.some((agent) => agentKeyOf(agent) === rootKey)
    ? [...agents]
    : [...agents, rootAgent];
}

/** Distinct member keys available to the run, excluding the root itself. */
export function availableTeamMemberCount(plan: TeamRunPlan): number {
  const rootKey = plan.rootAgent ? agentKeyOf(plan.rootAgent) : undefined;
  const memberKeys = [
    ...plan.agentKeys.workflow,
    ...plan.agentKeys.toolUse.filter((key) => key !== rootKey),
  ];
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
