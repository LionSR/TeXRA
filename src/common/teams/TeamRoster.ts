import type { TeamCatalogPortFailed } from '@common/teams/TeamAvailabilityPreflight';
import {
  AGENT_CATEGORIES,
  agentKeyOf,
  byCategory,
  type AgentCategory,
  type AgentModePreset,
  type AgentSource,
  type ByCategory,
} from '@shared/schemas';
import type { Effect } from 'effect';

/**
 * The roster's own identity rule (`AgentRosterController.resolveAgent`): a
 * bare name matches within the category, a `source:name` key matches exactly.
 * Resolving through it keeps this preflight and the roster snapshot's
 * `unresolvedNames` in agreement.
 */
interface TeamRosterAgentResolver {
  resolveAgent(
    category: AgentCategory,
    identifier: string,
  ): { name: string; source: AgentSource } | undefined;
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
type TeamRosterPresetResolution =
  | {
      readonly ok: true;
      readonly preset: AgentModePreset;
      readonly resolution: TeamRosterResolution;
    }
  | { readonly ok: false; readonly reason: 'unknownPreset' };

export interface TeamRosterCatalog {
  resolvePreset(
    presetId: string,
  ): Effect.Effect<TeamRosterPresetResolution, Error>;
  /**
   * Persist the symbolic preset. The resolution {@link resolvePreset} computed
   * is preflight evidence only: the roster stores the team reference and
   * re-resolves it against the catalog on read, so no committer freezes the
   * per-agent-key snapshot.
   */
  commitPreset(
    preset: AgentModePreset,
  ): Effect.Effect<void, TeamCatalogPortFailed>;
}

/** Resolve a team against the current catalog without writing roster state. */
export function resolveTeamRoster(
  roster: TeamRosterAgentResolver,
  preset: AgentModePreset,
): TeamRosterResolution {
  const resolved = byCategory((category) =>
    resolvePresetAgents(preset.agents[category], (name) =>
      roster.resolveAgent(category, name),
    ),
  );
  return {
    keys: byCategory((category) => resolved[category].resolved.map(agentKeyOf)),
    unresolvedNames: AGENT_CATEGORIES.flatMap(
      (category) => resolved[category].missing,
    ),
  };
}

/** Split a preset's member names into resolved entries and unmatched names. */
export function resolvePresetAgents<T>(
  names: readonly string[],
  resolve: (name: string) => T | undefined,
): { resolved: T[]; missing: string[] } {
  const resolved: T[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const entry = resolve(name);
    if (entry) resolved.push(entry);
    else missing.push(name);
  }
  return { resolved, missing };
}
