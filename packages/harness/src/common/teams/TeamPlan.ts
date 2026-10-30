import { Array as Arr, Result } from 'effect';
import {
  AGENT_TOOL_NAME,
  agentKeyOf,
  agentMatchesIdentifier,
  type AgentSource,
} from '@shared/schemas';

/** A team preset: its members by name, and where it came from. The app
 *  supplies the catalog (`AgentDirectoriesPort.teams`). */
export interface TeamPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** An icon name the host's icon set draws. */
  readonly icon: string;
  readonly agents: readonly string[];
  readonly source: 'built-in' | 'custom';
  /** The setup starter: an agent list a workspace can select, never a launch. */
  readonly setupOnly?: true;
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

function lookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function slugKey(value: string): string {
  return lookupKey(value).replaceAll(/\s+/g, '-');
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
  readonly agentKeys: readonly string[];
  /** Members that did not resolve, in preset-declaration order. */
  readonly missingAgents: readonly string[];
}

export interface TeamRunOptions<T extends TeamCatalogAgent> {
  /**
   * The workspace agents' member identity rule (`AgentCatalog.get` in
   * production): a bare name matches by name, a `source:name` key exactly.
   */
  readonly resolveAgent: (identifier: string) => T | undefined;
  /**
   * The agents a built-in team runs as its root, in preference order: the
   * first one among the team's delegating members leads it, and a built-in
   * team with none of them has no root. A custom team is led by its first
   * delegating member. The app owns these names.
   */
  readonly rootAgentNames: readonly string[];
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
    selectTeamRootAgent(members, preset.source, options.rootAgentNames);
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

/** The root a team's resolved `members` (in preset order) run under, as
 *  {@link TeamRunOptions.rootAgentNames} describes. */
function selectTeamRootAgent<T extends TeamCatalogAgent>(
  members: readonly T[],
  source: TeamPreset['source'],
  rootAgentNames: readonly string[],
): T | undefined {
  const delegatingAgents = members.filter((agent) =>
    agent.tools?.includes(AGENT_TOOL_NAME),
  );
  if (source === 'custom') return delegatingAgents[0];
  for (const identifier of rootAgentNames) {
    const root = delegatingAgents.find((agent) =>
      agentMatchesIdentifier(agent, identifier),
    );
    if (root) return root;
  }
  return undefined;
}
