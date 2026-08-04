import {
  agentKeyOf,
  agentMatchesIdentifier,
  byCategory,
  AGENT_CATEGORIES,
  type AgentCategory,
  type AgentSource,
  type ByCategory,
} from '@shared/schemas/agent';
import type { AgentModePreset } from '@shared/schemas/agentPresets';

export interface TeamRosterState {
  getAgents(category: AgentCategory): { name: string; source: AgentSource }[];
  setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: string[],
  ): Promise<void>;
}

export interface TeamRosterResolution {
  readonly keys: ByCategory<string[]>;
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
  commitPresetResolution(
    preset: AgentModePreset,
    resolution: TeamRosterResolution,
  ): Promise<void>;
}

/** Resolve a team against the current catalog without writing roster state. */
export function resolveTeamRoster(
  state: Pick<TeamRosterState, 'getAgents'>,
  preset: AgentModePreset,
): TeamRosterResolution {
  const resolved = byCategory((category) =>
    resolveAgentKeys(state, category, preset.agents[category]),
  );
  return {
    keys: byCategory((category) => resolved[category].keys),
    unresolvedNames: AGENT_CATEGORIES.flatMap(
      (category) => resolved[category].unresolved,
    ),
  };
}

/** Commit a previously resolved roster. */
export async function commitTeamRoster(
  state: Pick<TeamRosterState, 'setEnabledAgentKeys'>,
  resolution: TeamRosterResolution,
): Promise<void> {
  for (const category of AGENT_CATEGORIES) {
    await state.setEnabledAgentKeys(category, resolution.keys[category]);
  }
}

/**
 * Legacy presets without provenance conservatively preflight every unresolved
 * member. Known local members already resolve and therefore never enter this
 * set; explicit metadata remains authoritative for current presets.
 */
export function teamHostedNamesForPreflight(
  preset: AgentModePreset,
  unresolvedNames: readonly string[],
): ReadonlySet<string> {
  return new Set(preset.texraHostedAgents ?? unresolvedNames);
}

function resolveAgentKeys(
  state: Pick<TeamRosterState, 'getAgents'>,
  category: AgentCategory,
  names: string[],
): { keys: string[]; unresolved: string[] } {
  const entries = state.getAgents(category);
  const unresolved: string[] = [];
  const keys = names.map((name) => {
    const entry = entries.find((candidate) =>
      agentMatchesIdentifier(candidate, name),
    );
    if (entry) return agentKeyOf(entry);
    unresolved.push(name);
    return name;
  });
  return { keys, unresolved };
}
