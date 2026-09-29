import { Effect } from 'effect';
import type {
  TeamRosterCatalog,
  TeamRosterResolution,
} from '@common/teams/TeamRoster';
import type { AgentModePreset } from '@shared/schemas';

type TeamRosterApplicationResult =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'applied';
      readonly preset: AgentModePreset;
      readonly resolution: TeamRosterResolution;
    };

export interface TeamRosterApplicationDeps<R = never> {
  readonly catalog: TeamRosterCatalog;
  readonly loadCatalog: () => Effect.Effect<void, Error, R>;
}

/** Host sequence for resolving and committing one team roster. */
export function applyTeamRoster<R = never>(
  presetId: string,
  deps: TeamRosterApplicationDeps<R>,
): Effect.Effect<TeamRosterApplicationResult, Error, R> {
  return Effect.gen(function* () {
    yield* deps.loadCatalog();
    const resolved = yield* deps.catalog.resolvePreset(presetId);
    if (!resolved.ok) return { status: 'unknown' as const };
    yield* deps.catalog.commitPreset(resolved.preset);
    return {
      status: 'applied' as const,
      preset: resolved.preset,
      resolution: resolved.resolution,
    };
  });
}
