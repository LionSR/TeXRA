import type { TeamCatalogPortFailed } from '@common/teams/TeamAvailabilityPreflight';
import type { TeamRunPlan } from '@common/teams/TeamPlan';
import type { AgentModePreset } from '@shared/schemas';
import type { Effect } from 'effect';

/**
 * A team's members resolved against the catalog at resolve time, as
 * `planTeamRun` computes them: `agentKeys` holds only canonical source keys,
 * `missingAgents` the member names with no catalog entry. Nothing persists
 * the missing names: the roster stores the team reference and re-resolves
 * `preset.agents` on read, so a member activates the moment it appears in the
 * catalog (sign-in, install).
 */
export type TeamRosterResolution = Pick<
  TeamRunPlan,
  'agentKeys' | 'missingAgents'
>;

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
