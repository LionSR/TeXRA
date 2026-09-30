import { Data, Effect } from 'effect';
import type { WorkspaceAgentsController } from '@agent/workspaceAgents/WorkspaceAgentsController';
import {
  formatUnknownTeamMessage,
  missingMemberNames,
} from '@common/teams/TeamPlan';
import type { MessageHost } from '@hosts/uiHosts';
import type { StateReadFailed } from '@platform/interfaces';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

interface SettingsTeamCatalog {
  getPresetToolUseRoot(
    toolUseAgents: string[],
    presetId?: string,
  ): Effect.Effect<string | undefined, StateReadFailed>;
}

type SettingsTeamPresentation = Pick<
  MessageHost,
  'showInfoMessage' | 'showErrorMessage'
>;

interface SettingsTeamOptions<R> {
  readonly workspaceAgents: Pick<WorkspaceAgentsController, 'applyTeam'>;
  readonly catalog: SettingsTeamCatalog;
  readonly presentation: SettingsTeamPresentation;
  readonly refreshAfterApply: (
    selectedToolUseAgent?: string,
  ) => Effect.Effect<void, Error, R>;
}

/**
 * The host's own post-apply refresh rejected. It is the settings view
 * rebuilding itself, not a catalog operation, so it is its own answer: the
 * team is already committed when this fails.
 */
class TeamRefreshFailed extends Data.TaggedError('TeamRefreshFailed')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Apply a settings team and present its outcome consistently across hosts. */
export function applySettingsTeam<R = never>(
  presetId: string,
  options: SettingsTeamOptions<R>,
): Effect.Effect<void, Error, R> {
  return Effect.gen(function* () {
    const result = yield* options.workspaceAgents.applyTeam(presetId);

    switch (result.status) {
      case 'unknown':
        yield* options.presentation.showErrorMessage(
          formatUnknownTeamMessage(presetId),
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
              new TeamRefreshFailed({
                message: `The team was applied, but the settings view could not be refreshed: ${toErrorMessage(cause)}`,
                cause,
              }),
          ),
        );

        const unresolvedCount = missingMemberNames(result.resolution).length;
        yield* options.presentation.showInfoMessage(
          unresolvedCount === 0
            ? `Applied "${result.preset.name}" team`
            : `Applied "${result.preset.name}" with ${formatResultCount(unresolvedCount, 'member')} still unavailable`,
        );
        return;
      }
      default:
        return assertNever(
          result,
          'Unhandled settings team workspaceAgents outcome',
        );
    }
  });
}
