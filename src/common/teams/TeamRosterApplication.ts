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

/** Host sequence for resolving and committing one team roster. */
export function applyTeamRoster(
  presetId: string,
  deps: { readonly catalog: TeamRosterCatalog },
): Effect.Effect<TeamRosterApplicationResult, Error> {
  return Effect.gen(function* () {
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
