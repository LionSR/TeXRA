import type {
  AgentDelegationScope,
  AgentModePreset,
  AgentSource,
  ByCategory,
  TeamOptionData,
} from '@shared/schemas';
import {
  AGENT_CATEGORIES,
  AGENT_MODE_PRESETS,
  AgentCategory,
  agentKeyOf,
  agentMatchesIdentifier,
  byCategory,
  parseAgentModePresets,
  STARTER_AGENT_MODE_PRESET,
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
} from './TeamAvailabilityPreflight';
import { teamHostedNamesForPreflight } from './TeamRoster';

type TeamPresetSource = 'built-in' | 'custom';

export interface TeamPreset extends AgentModePreset {
  readonly source: TeamPresetSource;
}

/**
 * Return launchable team presets in display order. Built-in ids are reserved:
 * a custom preset with the same id is dropped so the built-in always wins. The
 * setup-only starter id is reserved as well and never appears in this listing.
 */
export function teamPresets(customRaw: unknown): TeamPreset[] {
  const builtInIds = new Set([
    ...AGENT_MODE_PRESETS.map((preset) => preset.id),
    STARTER_AGENT_MODE_PRESET.id,
  ]);
  return [
    ...AGENT_MODE_PRESETS.map((preset) => ({
      ...preset,
      source: 'built-in' as const,
    })),
    ...parseAgentModePresets(customRaw)
      .filter((preset) => !builtInIds.has(preset.id))
      .map((preset) => ({ ...preset, source: 'custom' as const })),
  ];
}

export function findTeamPreset(
  presets: readonly TeamPreset[],
  query: string,
): TeamPreset | undefined {
  const key = lookupKey(query);
  return presets.find(
    (preset) =>
      lookupKey(preset.id) === key ||
      lookupKey(preset.name) === key ||
      slugKey(preset.name) === key,
  );
}

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

interface TeamRunOptions<T extends TeamCatalogAgent> {
  readonly agents: ByCategory<readonly T[]>;
  readonly agentOverride?: string;
}

export function planTeamRun<T extends TeamCatalogAgent>(
  preset: TeamPreset,
  options: TeamRunOptions<T>,
): TeamRunPlan<T> {
  const resolved = byCategory((category) =>
    resolvePresetAgents(preset.agents[category], options.agents[category]),
  );
  const override = resolveAgentOverride(
    options.agentOverride,
    options.agents.toolUse,
  );
  const rootAgent =
    override.agent ??
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
    missingAgentOverride: override.missing,
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

/** TeXRA-hosted definitions missing from this plan, independent of models. */
export function teamTexraHostedMissingNames(plan: TeamRunPlan): string[] {
  const missing = missingMemberNames(plan);
  const hosted = teamHostedNamesForPreflight(plan.preset, missing);
  return missing.filter((name) => hosted.has(name));
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
  cliMultiAgentPresetId: string;
} {
  return {
    agent: agentKeyOf(plan.rootAgent),
    delegationAgentScope: byCategory((category) => [
      ...plan.agentKeys[category],
    ]),
    cliMultiAgentPresetId: plan.preset.id,
  };
}

export function buildTeamOptions(
  plans: readonly TeamRunPlan[],
): TeamOptionData[] {
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

export async function loadTeamOptions<T extends TeamCatalogAgent>(ports: {
  customPresetsRaw: unknown;
  ensureCatalogLoaded: () => Promise<void>;
  getAgents: (category: AgentCategory) => readonly T[];
  canAccessRemoteCatalog: () => Promise<boolean>;
  refreshRemote: () => Promise<void>;
}): Promise<TeamOptionData[]> {
  await ports.ensureCatalogLoaded();
  const presets = teamPresets(ports.customPresetsRaw);
  const planCurrent = () =>
    planTeamRuns(presets, currentCatalogOptions(ports.getAgents));
  const result = await refreshRemoteCatalogForGaps(
    planCurrent(),
    (plans) => plans.some(teamPlanHasGaps),
    planCurrent,
    ports,
  );
  return buildTeamOptions(result.value);
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

export async function resolveTeamLaunch<T extends TeamCatalogAgent>(args: {
  teamId: string;
  customPresetsRaw: unknown;
  ensureCatalogLoaded: () => Promise<void>;
  getAgents: (category: AgentCategory) => readonly T[];
  canAccessRemoteCatalog: () => Promise<boolean>;
  refreshRemote: () => Promise<void>;
  choose: (
    unavailableNames: readonly string[],
  ) => Promise<TeamAvailabilityChoice | undefined>;
  signIn: () => Promise<boolean>;
  providedChoice?: TeamAvailabilityChoice;
}): Promise<TeamLaunchResolution> {
  const preset = findTeamPreset(
    teamPresets(args.customPresetsRaw),
    args.teamId,
  );
  if (!preset) return { status: 'unknown-team' };

  await args.ensureCatalogLoaded();
  const planCurrent = () =>
    planTeamRun(preset, currentCatalogOptions(args.getAgents));
  const refreshed = await refreshRemoteCatalogForGaps(
    planCurrent(),
    teamPlanHasGaps,
    planCurrent,
    args,
  );
  const preflight = await preflightTeamAvailability({
    initial: refreshed.value,
    unresolvedNames: teamTexraHostedMissingNames,
    texraHostedNames: teamHostedNamesForPreflight(
      preset,
      missingMemberNames(refreshed.value),
    ),
    canAccessRemoteCatalog: args.canAccessRemoteCatalog,
    providedChoice: args.providedChoice,
    choose: args.choose,
    signIn: args.signIn,
    refresh: async () => {
      await args.refreshRemote();
      return planCurrent();
    },
    remoteCatalogRefreshAttempted: refreshed.remoteCatalogRefreshAttempted,
  });

  // 'choice-required' is reachable only when no provided choice exists and the
  // interactive choice port returns no decision; hosts treat dismissal as cancel.
  if (
    preflight.status === 'cancelled' ||
    preflight.status === 'choice-required'
  ) {
    return { status: 'cancelled' };
  }
  if (preflight.status === 'unavailable') {
    return {
      status: 'unavailable',
      unavailableNames: preflight.unavailableNames,
    };
  }

  const plan = preflight.value;
  if (!canLaunchTeam(plan)) {
    return {
      status: 'blocked',
      reason: teamLaunchBlockReason(plan)!,
    };
  }
  return {
    status: 'ready',
    fields: teamExecutionFields(plan),
    partial: preflight.partial,
    missingNames: missingMemberNames(plan),
  };
}

export async function refreshRemoteCatalogForGaps<T>(
  value: T,
  hasGaps: (value: T) => boolean,
  replan: () => T,
  ports: {
    canAccessRemoteCatalog: () => Promise<boolean>;
    refreshRemote: () => Promise<void>;
  },
): Promise<{ value: T; remoteCatalogRefreshAttempted: boolean }> {
  if (hasGaps(value) && (await ports.canAccessRemoteCatalog())) {
    await ports.refreshRemote();
    return { value: replan(), remoteCatalogRefreshAttempted: true };
  }
  return { value, remoteCatalogRefreshAttempted: false };
}

// ---------------------------------------------------------------------------
// Launch dialog copy. Hosts render these strings through their own dialogs
// (VS Code vs Electron native); keeping the literals here stops them drifting.
// ---------------------------------------------------------------------------

/** Button labels for the unavailable-members choice, in display order. */
export const TEAM_LAUNCH_SIGN_IN_LABEL = 'Sign In to TeXRA';
export const TEAM_LAUNCH_CONTINUE_LABEL = 'Continue with Available Members';
export const TEAM_LAUNCH_CANCEL_LABEL = 'Cancel';

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
export function formatUnavailableTeamMembersMessage(
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

/** Snapshot the current agent catalog into run options for (re)planning. */
function currentCatalogOptions<T extends TeamCatalogAgent>(
  getAgents: (category: AgentCategory) => readonly T[],
): TeamRunOptions<T> {
  return { agents: byCategory((category) => getAgents(category)) };
}

/** Missing workflow and tool-use member names, in preset-declaration order. */
function missingMemberNames(plan: TeamRunPlan): string[] {
  return AGENT_CATEGORIES.flatMap((category) => plan.missingAgents[category]);
}

function resolvePresetAgents<T extends TeamCatalogAgent>(
  names: readonly string[],
  agents: readonly T[],
): { resolved: T[]; missing: string[] } {
  const resolved: T[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const entry = agents.find((agent) => agentMatchesIdentifier(agent, name));
    if (entry) resolved.push(entry);
    else missing.push(name);
  }
  return { resolved, missing };
}

function resolveAgentOverride<T extends TeamCatalogAgent>(
  override: string | undefined,
  agents: readonly T[],
): { agent?: T; missing?: string } {
  const query = override?.trim();
  if (!query) return {};
  const agent = agents.find((entry) => agentMatchesIdentifier(entry, query));
  return agent ? { agent } : { missing: query };
}

function selectTeamRootAgent<T extends TeamCatalogAgent>(
  agents: readonly T[],
  options: {
    readonly presetOrder: readonly string[];
    readonly presetSource: TeamPresetSource;
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

function lookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function slugKey(value: string): string {
  return lookupKey(value).replaceAll(/\s+/g, '-');
}
