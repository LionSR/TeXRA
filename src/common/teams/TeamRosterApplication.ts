import { Effect } from 'effect';
import {
  preflightTeamAvailability,
  type TeamAvailabilityChoice,
  type TeamCatalogPortFailed,
} from '@common/teams/TeamAvailabilityPreflight';
import type {
  TeamRosterCatalog,
  TeamRosterResolution,
} from '@common/teams/TeamRoster';
import type { SignInFailed } from '@common/errors/signInFailed';
import type { AgentModePreset } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface ResolvedTeam {
  readonly ok: true;
  readonly preset: AgentModePreset;
  readonly resolution: TeamRosterResolution;
}

type TeamRosterApplicationResult =
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

export interface TeamRosterApplicationDeps<R = never> {
  readonly catalog: TeamRosterCatalog;
  readonly loadLocalCatalog: () => Effect.Effect<void, unknown, R>;
  readonly canAccessRemoteCatalog: () => Effect.Effect<boolean>;
  /** A decision already supplied by a non-interactive caller. */
  readonly providedChoice?: TeamAvailabilityChoice;
  readonly choose: (
    preset: AgentModePreset,
    unavailableNames: readonly string[],
  ) => Effect.Effect<TeamAvailabilityChoice | undefined, TeamCatalogPortFailed>;
  readonly signIn: () => Effect.Effect<boolean, SignInFailed>;
  readonly forceRefreshRemoteCatalog: () => Effect.Effect<void, unknown, R>;
}

/** Host sequence for preflighting and committing one team roster. */
export function applyTeamRosterWithPreflight<R = never>(
  presetId: string,
  deps: TeamRosterApplicationDeps<R>,
): Effect.Effect<TeamRosterApplicationResult, unknown, R> {
  return Effect.gen(function* () {
    yield* deps.loadLocalCatalog();
    const initial = yield* deps.catalog.resolvePreset(presetId);
    if (!initial.ok) return { status: 'unknown' as const };

    const preflight = yield* preflightTeamAvailability<ResolvedTeam, R>({
      initial,
      unresolvedNames: (value) => value.resolution.unresolvedNames,
      texraHostedNames: new Set(initial.preset.texraHostedAgents),
      canAccessRemoteCatalog: deps.canAccessRemoteCatalog,
      providedChoice: deps.providedChoice,
      choose: (names) => deps.choose(initial.preset, names),
      signIn: deps.signIn,
      refreshRemote: deps.forceRefreshRemoteCatalog,
      replan: () =>
        Effect.gen(function* () {
          const refreshed = yield* deps.catalog.resolvePreset(presetId);
          if (!refreshed.ok) {
            return yield* Effect.fail(
              new Error(`Team no longer exists: ${presetId}`),
            );
          }
          return refreshed;
        }),
    });

    if (preflight.status === 'cancelled') {
      return { status: 'cancelled' as const, preset: initial.preset };
    }
    if (preflight.status === 'choice-required') {
      return {
        status: 'choice-required' as const,
        preset: initial.preset,
        unavailableNames: preflight.unavailableNames,
      };
    }
    if (preflight.status === 'unavailable') {
      return {
        status: 'unavailable' as const,
        preset: initial.preset,
        unavailableNames: preflight.unavailableNames,
      };
    }

    yield* deps.catalog.commitPreset(preflight.value.preset);
    return {
      status: 'applied' as const,
      preset: preflight.value.preset,
      resolution: preflight.value.resolution,
    };
  });
}
