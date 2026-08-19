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

interface TeamRosterState {
  getAgents(category: AgentCategory): { name: string; source: AgentSource }[];
  setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: string[],
  ): Promise<void>;
}

export interface TeamRosterResolution {
  /**
   * Agent keys that resolved against the catalog at resolve time. Contains
   * only canonical source keys — never raw member names (see {@link nameSlots}).
   */
  readonly keys: ByCategory<string[]>;
  /**
   * Roster member names that did not resolve to a catalog entry at resolve
   * time, per category. These persist alongside `keys` as name-matched slots,
   * so an agent activates the moment it appears in the catalog (sign-in,
   * install) — never silently dropped.
   */
  readonly nameSlots: ByCategory<string[]>;
  /** Unresolved member names across all categories, in canonical order. */
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
    nameSlots: byCategory((category) => resolved[category].nameSlots),
    unresolvedNames: AGENT_CATEGORIES.flatMap(
      (category) => resolved[category].nameSlots,
    ),
  };
}

/** Commit a previously resolved roster. */
export async function commitTeamRoster(
  state: Pick<TeamRosterState, 'setEnabledAgentKeys'>,
  resolution: TeamRosterResolution,
): Promise<void> {
  for (const category of AGENT_CATEGORIES) {
    // Resolved keys and unresolved name slots persist side by side so a
    // name-matched member activates the moment it appears in the catalog.
    await state.setEnabledAgentKeys(category, [
      ...resolution.keys[category],
      ...resolution.nameSlots[category],
    ]);
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
): { keys: string[]; nameSlots: string[] } {
  const entries = state.getAgents(category);
  const keys: string[] = [];
  const nameSlots: string[] = [];
  for (const name of names) {
    const entry = entries.find((candidate) =>
      agentMatchesIdentifier(candidate, name),
    );
    if (entry) {
      keys.push(agentKeyOf(entry));
    } else {
      nameSlots.push(name);
    }
  }
  return { keys, nameSlots };
}
