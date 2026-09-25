/**
 * The Git page of the settings body: the GitHub token and the PR, repo and
 * issue subscriptions runs hold.
 */
import { Effect } from 'effect';

import { storeCredential } from '@common/secrets/storeCredential';
import {
  listGitHubSubscriptionEntries,
  noActiveGitHubSubscriptionMessage,
  unsubscribeGitHubKey,
} from '@controllers/settingsView/githubSubscriptions';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import type { PlatformSecrets } from '@platform/secrets';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  GITHUB_TOKEN_PROMPT,
  GITHUB_TOKEN_REMOVED_MESSAGE,
  GITHUB_TOKEN_SAVED_MESSAGE,
  GITHUB_TOKEN_STORAGE_KEY,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';

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
    getGitHubTokenStatus: () => postGitHubTokenStatus,
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
    getPRSubscriptions: () => postGitHubSubscriptions,
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
              'The run view is not available. Please try again.',
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
