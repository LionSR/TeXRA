import { Effect } from 'effect';
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
import { hostPort } from '@common/hostPort';
import type { MessageHost } from '@hosts/uiHosts';
import { assertNever } from '@utils/core';
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
        yield* hostPort(() =>
          options.presentation.showErrorMessage(
            formatUnknownTeamMessage(presetId),
          ),
        );
        return;
      case 'choice-required':
      case 'cancelled':
        return;
      case 'unavailable':
        yield* hostPort(() =>
          options.presentation.showErrorMessage(
            formatTeamUnavailableMessage(
              result.preset.name,
              result.unavailableNames,
            ),
          ),
        );
        return;
      case 'applied': {
        const selectedToolUseAgent = options.catalog.getPresetToolUseRoot(
          result.preset.agents.toolUse,
          result.preset.id,
        );
        yield* hostPort(() => options.refreshAfterApply(selectedToolUseAgent));

        const unresolvedCount = result.resolution.unresolvedNames.length;
        yield* hostPort(() =>
          options.presentation.showInfoMessage(
            unresolvedCount === 0
              ? `Applied "${result.preset.name}" team`
              : `Applied "${result.preset.name}" with ${formatResultCount(unresolvedCount, 'member')} still unavailable`,
          ),
        );
        return;
      }
      default:
        return assertNever(result, 'Unhandled settings team roster outcome');
    }
  });
}
