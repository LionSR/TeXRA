import {
  preflightTeamAvailability,
  type TeamAvailabilityChoice,
} from '@common/teams/TeamAvailabilityPreflight';
import {
  teamHostedNamesForPreflight,
  type TeamRosterCatalog,
  type TeamRosterResolution,
} from '@common/teams/TeamRoster';
import type { AgentModePreset } from '@shared/schemas';

interface ResolvedTeam {
  readonly ok: true;
  readonly preset: AgentModePreset;
  readonly resolution: TeamRosterResolution;
}

export type TeamRosterApplicationResult =
  | { readonly status: 'unknown' }
  | { readonly status: 'cancelled'; readonly preset: AgentModePreset }
  | {
      readonly status: 'choice-required';
      readonly preset: AgentModePreset;
      readonly unavailableNames: readonly string[];
    }
  | {
      readonly status: 'unavailable';
      readonly preset: AgentModePreset;
      readonly unavailableNames: readonly string[];
    }
  | {
      readonly status: 'applied';
      readonly preset: AgentModePreset;
      readonly resolution: TeamRosterResolution;
    };

export interface TeamRosterApplicationDeps {
  readonly catalog: TeamRosterCatalog;
  readonly loadLocalCatalog: () => Promise<void>;
  readonly canAccessRemoteCatalog: () => Promise<boolean>;
  /** A decision already supplied by a non-interactive caller. */
  readonly providedChoice?: TeamAvailabilityChoice;
  readonly choose: (
    preset: AgentModePreset,
    unavailableNames: readonly string[],
  ) => Promise<TeamAvailabilityChoice | undefined>;
  readonly signIn: () => Promise<boolean>;
  readonly forceRefreshRemoteCatalog: () => Promise<void>;
}

/** Host sequence for preflighting and committing one team roster. */
export async function applyTeamRosterWithPreflight(
  presetId: string,
  deps: TeamRosterApplicationDeps,
): Promise<TeamRosterApplicationResult> {
  await deps.loadLocalCatalog();
  const initial = deps.catalog.resolvePreset(presetId);
  if (!initial.ok) return { status: 'unknown' };

  const preflight = await preflightTeamAvailability<ResolvedTeam>({
    initial,
    unresolvedNames: (value) => value.resolution.unresolvedNames,
    texraHostedNames: teamHostedNamesForPreflight(
      initial.preset,
      initial.resolution.unresolvedNames,
    ),
    canAccessRemoteCatalog: deps.canAccessRemoteCatalog,
    providedChoice: deps.providedChoice,
    choose: (names) => deps.choose(initial.preset, names),
    signIn: deps.signIn,
    refresh: async () => {
      await deps.forceRefreshRemoteCatalog();
      const refreshed = deps.catalog.resolvePreset(presetId);
      if (!refreshed.ok) throw new Error(`Team no longer exists: ${presetId}`);
      return refreshed;
    },
  });

  if (preflight.status === 'cancelled') {
    return { status: 'cancelled', preset: initial.preset };
  }
  if (preflight.status === 'choice-required') {
    return {
      status: 'choice-required',
      preset: initial.preset,
      unavailableNames: preflight.unavailableNames,
    };
  }
  if (preflight.status === 'unavailable') {
    return {
      status: 'unavailable',
      preset: initial.preset,
      unavailableNames: preflight.unavailableNames,
    };
  }

  await deps.catalog.commitPresetResolution(
    preflight.value.preset,
    preflight.value.resolution,
  );
  return {
    status: 'applied',
    preset: preflight.value.preset,
    resolution: preflight.value.resolution,
  };
}
