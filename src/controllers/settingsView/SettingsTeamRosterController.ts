import { Data, Effect } from 'effect';
import type { TeamAvailabilityChoice } from '@common/teams/TeamAvailabilityPreflight';
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
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

type SettingsTeamRosterCatalog = TeamRosterApplicationDeps['catalog'] & {
  getPresetToolUseRoot(
    toolUseAgents: string[],
    presetId?: string,
  ): string | undefined;
};

interface SettingsTeamRosterPresentation extends Pick<
  MessageHost,
  'showInfoMessage' | 'showErrorMessage'
> {
  chooseTeamAvailability(
    prompt: TeamAvailabilityPrompt,
  ): Promise<TeamAvailabilityChoice | undefined>;
}

interface SettingsTeamRosterOptions extends Omit<
  TeamRosterApplicationDeps,
  'catalog' | 'choose'
> {
  readonly catalog: SettingsTeamRosterCatalog;
  readonly presentation: SettingsTeamRosterPresentation;
  readonly refreshAfterApply: (selectedToolUseAgent?: string) => Promise<void>;
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

/**
 * A settings message never reached the user: the host's own dialog surface
 * faulted. Declared beside the presentation bag it belongs to rather than
 * beside `MessageHost`, because `src` keeps `controllers -> hosts` a
 * type-only edge.
 */
class TeamRosterNotificationFailed extends Data.TaggedError(
  'TeamRosterNotificationFailed',
)<{
  readonly member: 'showInfoMessage' | 'showErrorMessage';
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Show one settings message, reporting a host that could not present it. */
const notify = (
  present: (message: string) => Promise<void> | void,
  member: TeamRosterNotificationFailed['member'],
  message: string,
): Effect.Effect<void, TeamRosterNotificationFailed> =>
  Effect.tryPromise({
    try: async () => {
      await present(message);
    },
    catch: (cause) =>
      new TeamRosterNotificationFailed({ member, message, cause }),
  });

/** Apply a settings team and present its outcome consistently across hosts. */
export function applySettingsTeamRoster(
  presetId: string,
  options: SettingsTeamRosterOptions,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const result = yield* applyTeamRosterWithPreflight(presetId, {
      ...options,
      choose: (preset, unavailableNames) =>
        options.presentation.chooseTeamAvailability(
          teamAvailabilityPrompt(unavailableNames, preset.name),
        ),
    });

    switch (result.status) {
      case 'unknown':
        yield* notify(
          (text) => options.presentation.showErrorMessage(text),
          'showErrorMessage',
          formatUnknownTeamMessage(presetId),
        );
        return;
      case 'choice-required':
      case 'cancelled':
        return;
      case 'unavailable':
        yield* notify(
          (text) => options.presentation.showErrorMessage(text),
          'showErrorMessage',
          formatTeamUnavailableMessage(
            result.preset.name,
            result.unavailableNames,
          ),
        );
        return;
      case 'applied': {
        const selectedToolUseAgent = options.catalog.getPresetToolUseRoot(
          result.preset.agents.toolUse,
          result.preset.id,
        );
        yield* Effect.tryPromise({
          try: () => options.refreshAfterApply(selectedToolUseAgent),
          catch: (cause) =>
            new TeamRosterRefreshFailed({
              message: `The team was applied, but the settings view could not be refreshed: ${toErrorMessage(cause)}`,
              cause,
            }),
        });

        const unresolvedCount = result.resolution.unresolvedNames.length;
        yield* notify(
          (text) => options.presentation.showInfoMessage(text),
          'showInfoMessage',
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
