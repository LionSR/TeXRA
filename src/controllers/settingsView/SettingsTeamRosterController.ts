import type { TeamAvailabilityChoice } from '@common/teams/TeamAvailabilityPreflight';
import {
  formatTeamUnavailableMessage,
  formatUnavailableTeamMembersMessage,
  formatUnknownTeamMessage,
  TEAM_LAUNCH_CANCEL_LABEL,
  TEAM_LAUNCH_CONTINUE_LABEL,
  TEAM_LAUNCH_SIGN_IN_LABEL,
} from '@common/teams/TeamPlan';
import {
  applyTeamRosterWithPreflight,
  type TeamRosterApplicationDeps,
} from '@common/teams/TeamRosterApplication';
import { assertNever } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

type SettingsTeamRosterCatalog = TeamRosterApplicationDeps['catalog'] & {
  getPresetToolUseRoot(
    toolUseAgents: string[],
    presetId?: string,
  ): string | undefined;
};

export interface SettingsTeamAvailabilityPrompt {
  readonly severity: 'warning';
  readonly message: string;
  readonly actions: readonly [
    { readonly choice: 'sign-in'; readonly label: string },
    { readonly choice: 'continue'; readonly label: string },
    { readonly choice: 'cancel'; readonly label: string },
  ];
}

export interface SettingsTeamRosterPresentation {
  chooseTeamAvailability(
    prompt: SettingsTeamAvailabilityPrompt,
  ): Promise<TeamAvailabilityChoice | undefined>;
  showInfoMessage(message: string): Promise<void>;
  showErrorMessage(message: string): Promise<void>;
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
export async function applySettingsTeamRoster(
  presetId: string,
  options: SettingsTeamRosterOptions,
): Promise<void> {
  const result = await applyTeamRosterWithPreflight(presetId, {
    ...options,
    choose: (preset, unavailableNames) =>
      options.presentation.chooseTeamAvailability({
        severity: 'warning',
        message: formatUnavailableTeamMembersMessage(
          unavailableNames,
          preset.name,
        ),
        actions: [
          { choice: 'sign-in', label: TEAM_LAUNCH_SIGN_IN_LABEL },
          { choice: 'continue', label: TEAM_LAUNCH_CONTINUE_LABEL },
          { choice: 'cancel', label: TEAM_LAUNCH_CANCEL_LABEL },
        ],
      }),
  });

  switch (result.status) {
    case 'unknown':
      await options.presentation.showErrorMessage(
        formatUnknownTeamMessage(presetId),
      );
      return;
    case 'choice-required':
    case 'cancelled':
      return;
    case 'unavailable':
      await options.presentation.showErrorMessage(
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
      await options.refreshAfterApply(selectedToolUseAgent);

      const unresolvedCount = result.resolution.unresolvedNames.length;
      await options.presentation.showInfoMessage(
        unresolvedCount === 0
          ? `Applied "${result.preset.name}" team`
          : `Applied "${result.preset.name}" with ${formatResultCount(unresolvedCount, 'member')} still unavailable`,
      );
      return;
    }
    default:
      return assertNever(result, 'Unhandled settings team roster outcome');
  }
}
