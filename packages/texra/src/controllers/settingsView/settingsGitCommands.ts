/**
 * The Git page of the settings body: the GitHub token and the PR, repo and
 * issue subscriptions runs hold.
 */
import { Effect } from 'effect';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { storeCredential } from '@texra/common/secrets/storeCredential';
import {
  listGitHubSubscriptionEntries,
  noActiveGitHubSubscriptionMessage,
  unsubscribeGitHubKey,
} from '@texra/controllers/settingsView/githubSubscriptions';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import {
  GITHUB_TOKEN_PROMPT,
  GITHUB_TOKEN_REMOVED_MESSAGE,
  GITHUB_TOKEN_SAVED_MESSAGE,
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@texra/tools/github/githubAuth';
import type { PlatformSecrets } from '@texra-ai/harness';

import type {
  SettingsHostBindings,
  SettingsPresentation,
} from './settingsHostBindings';

/** The Git page: its arms and its opening data. */
export function settingsGitCommands(ports: {
  readonly bindings: SettingsHostBindings;
  readonly present: SettingsPresentation;
  readonly secrets: PlatformSecrets;
}) {
  const { bindings, secrets } = ports;
  const { notice, alert, reported } = ports.present;
  const postGitHubTokenStatus = bindings.post(
    Effect.map(resolveGitHubTokenSource(secrets), (status) => ({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
      status,
    })),
  );
  const postGitHubSubscriptions = bindings.post(
    Effect.map(
      listGitHubSubscriptionEntries(bindings.runLabel),
      (subscriptions) => ({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
        subscriptions,
      }),
    ),
  );

  const handlers = {
    setGitHubToken: () =>
      Effect.gen(function* () {
        const token = yield* bindings.prompt.input({
          prompt: GITHUB_TOKEN_PROMPT,
          placeHolder: 'ghp_…',
          password: true,
        });
        if (token == null) return;
        yield* reported(
          'Failed to save GitHub token',
          storeCredential(secrets, {
            secretName: GITHUB_TOKEN_STORAGE_KEY,
            value: token,
            kind: 'github',
          }).pipe(
            Effect.andThen(notice(GITHUB_TOKEN_SAVED_MESSAGE)),
            Effect.andThen(postGitHubTokenStatus),
          ),
        );
      }),
    removeGitHubToken: () =>
      reported(
        'Failed to remove GitHub token',
        secrets
          .delete(GITHUB_TOKEN_STORAGE_KEY)
          .pipe(
            Effect.andThen(notice(GITHUB_TOKEN_REMOVED_MESSAGE)),
            Effect.andThen(postGitHubTokenStatus),
          ),
      ),
    unsubscribePR: ({ key }) =>
      Effect.flatMap(unsubscribeGitHubKey(key), (removed) =>
        removed === 0
          ? notice(noActiveGitHubSubscriptionMessage(key))
          : postGitHubSubscriptions,
      ),
    // Jump from a subscription to the run that owns it; a run deleted since
    // has nothing to show, so say so instead of leaving the click inert.
    openPRSubscriptionStream: ({ runId }) =>
      Effect.flatMap(
        bindings.revealRun(runId),
        (result) =>
          ({
            revealed: Effect.void,
            missing: notice('The agent run is no longer available.'),
            unavailable: alert(
              'The Sessions view is not available. Please try again.',
            ),
          })[result],
      ),
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;
  return {
    handlers,
    postTokenStatus: postGitHubTokenStatus,
    postSubscriptions: postGitHubSubscriptions,
  };
}
