import {
  AGENT_CATEGORIES,
  agentKeyOf,
  agentMatchesIdentifier,
  byCategory,
  type AgentCategory,
  type AgentModePreset,
  type AgentSource,
  type ByCategory,
} from '@shared/schemas';

interface TeamRosterAgentCatalog {
  getAgents(category: AgentCategory): { name: string; source: AgentSource }[];
}

export interface TeamRosterResolution {
  /**
   * Agent keys that resolved against the catalog at resolve time. Contains
   * only canonical source keys — never raw member names.
   */
  readonly keys: ByCategory<string[]>;
  /**
   * Member names that did not resolve to a catalog entry at resolve time,
   * across all categories in canonical order, for the availability preflight.
   * Nothing persists these: the roster stores the team reference and
   * re-resolves `preset.agents` on read, so a member activates the moment it
   * appears in the catalog (sign-in, install).
   */
  readonly unresolvedNames: string[];
}

/** Outcome of matching a preset id against the catalog's known presets. */
export type TeamRosterPresetResolution =
  | {
      readonly ok: true;
      readonly preset: AgentModePreset;
      readonly resolution: TeamRosterResolution;
    }
  | { readonly ok: false; readonly reason: 'unknownPreset' };

export interface TeamRosterCatalog {
  resolvePreset(presetId: string): TeamRosterPresetResolution;
  /**
   * Persist the symbolic preset. The resolution {@link resolvePreset} computed
   * is preflight evidence only: the roster stores the team reference and
   * re-resolves it against the catalog on read, so no committer freezes the
   * per-agent-key snapshot.
   */
  commitPreset(preset: AgentModePreset): Promise<void>;
}

/** Resolve a team against the current catalog without writing roster state. */
export function resolveTeamRoster(
  state: TeamRosterAgentCatalog,
  preset: AgentModePreset,
): TeamRosterResolution {
  const resolved = byCategory((category) =>
    resolvePresetAgents(preset.agents[category], state.getAgents(category)),
  );
  return {
    keys: byCategory((category) => resolved[category].resolved.map(agentKeyOf)),
    unresolvedNames: AGENT_CATEGORIES.flatMap(
      (category) => resolved[category].missing,
    ),
  };
}

/** Split a preset's member names into catalog entries and unmatched names. */
export function resolvePresetAgents<
  T extends { readonly name: string; readonly source: AgentSource },
>(
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
