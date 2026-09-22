import { Data, Effect } from 'effect';
import type {
  TeamAvailabilityChoice,
  TeamCatalogPortFailed,
} from '@common/teams/TeamAvailabilityPreflight';
import {
  formatTeamUnavailableMessage,
  formatUnknownTeamMessage,
  teamAvailabilityPrompt,
  type TeamAvailabilityPrompt,
} from '@common/teams/TeamPlan';
import {
  applyTeamRosterWithPreflight,
  type TeamRosterApplicationDeps,
} from '@common/teams/TeamRosterApplication';
import type { MessageHost } from '@hosts/uiHosts';
import type { StateReadFailed } from '@platform/interfaces';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

type SettingsTeamRosterCatalog = TeamRosterApplicationDeps['catalog'] & {
  getPresetToolUseRoot(
    toolUseAgents: string[],
    presetId?: string,
  ): Effect.Effect<string | undefined, StateReadFailed>;
};

interface SettingsTeamRosterPresentation extends Pick<
  MessageHost,
  'showInfoMessage' | 'showErrorMessage'
> {
  chooseTeamAvailability(
    prompt: TeamAvailabilityPrompt,
  ): Effect.Effect<TeamAvailabilityChoice | undefined, TeamCatalogPortFailed>;
}

interface SettingsTeamRosterOptions<R> extends Omit<
  TeamRosterApplicationDeps<R>,
  'catalog' | 'choose'
> {
  readonly catalog: SettingsTeamRosterCatalog;
  readonly presentation: SettingsTeamRosterPresentation;
  readonly refreshAfterApply: (
    selectedToolUseAgent?: string,
  ) => Effect.Effect<void, unknown, R>;
}

/**
 * The host's own post-apply refresh rejected. It is the settings view
 * rebuilding itself, not a catalog operation, so it is its own answer: the
 * team is already committed when this fails.
 */
class TeamRosterRefreshFailed extends Data.TaggedError(
  'TeamRosterRefreshFailed',
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Apply a settings team and present its outcome consistently across hosts. */
export function applySettingsTeamRoster<R = never>(
  presetId: string,
  options: SettingsTeamRosterOptions<R>,
): Effect.Effect<void, unknown, R> {
  return Effect.gen(function* () {
    const result = yield* applyTeamRosterWithPreflight<R>(presetId, {
      ...options,
      choose: (preset, unavailableNames) =>
        options.presentation.chooseTeamAvailability(
          teamAvailabilityPrompt(unavailableNames, preset.name),
        ),
    });

    switch (result.status) {
      case 'unknown':
        yield* options.presentation.showErrorMessage(
          formatUnknownTeamMessage(presetId),
        );
        return;
      case 'choice-required':
      case 'cancelled':
        return;
      case 'unavailable':
        yield* options.presentation.showErrorMessage(
          formatTeamUnavailableMessage(
            result.preset.name,
            result.unavailableNames,
          ),
        );
        return;
      case 'applied': {
        const selectedToolUseAgent =
          yield* options.catalog.getPresetToolUseRoot(
            result.preset.agents.toolUse,
            result.preset.id,
          );
        yield* options.refreshAfterApply(selectedToolUseAgent).pipe(
          Effect.mapError(
            (cause) =>
              new TeamRosterRefreshFailed({
                message: `The team was applied, but the settings view could not be refreshed: ${toErrorMessage(cause)}`,
                cause,
              }),
          ),
        );

        const unresolvedCount = result.resolution.unresolvedNames.length;
        yield* options.presentation.showInfoMessage(
          unresolvedCount === 0
            ? `Applied "${result.preset.name}" team`
            : `Applied "${result.preset.name}" with ${formatResultCount(unresolvedCount, 'member')} still unavailable`,
        );
        return;
      }
      default:
        return assertNever(result, 'Unhandled settings team roster outcome');
    }
  });
}
