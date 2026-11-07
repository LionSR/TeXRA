/**
 * The Git page of the settings body: the GitHub token and the PR, repo and
 * issue subscriptions runs hold.
 */
import { Effect } from 'effect';

import { Secrets } from '@texra-ai/harness/plugins';
import { storeCredential } from '@texra/common/secrets/storeCredential';
import {
  listGitHubSubscriptionEntries,
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

import {
  hostStatePage,
  type SettingsHostBindings,
  type SettingsPresentation,
} from './settingsHostBindings';

/** The Git page: its arms and its pages. */
export function settingsGitCommands(ports: {
  readonly bindings: SettingsHostBindings;
  readonly present: SettingsPresentation;
}) {
  const { bindings } = ports;
  const { notice, alert, reported, changed } = ports.present;
  const pages = [
    hostStatePage(
      'githubToken',
      ['github'],
      Effect.map(
        Effect.flatMap(Secrets, resolveGitHubTokenSource),
        (status) => ({
          status,
        }),
      ),
    ),
    hostStatePage(
      'prSubscriptions',
      ['github'],
      Effect.map(
        listGitHubSubscriptionEntries(bindings.runLabel),
        (subscriptions) => ({ subscriptions }),
      ),
    ),
  ];

  const handlers = {
    setGitHubToken: Effect.fn('settingsGitCommands.setGitHubToken')(
      function* () {
        const token = yield* bindings.dialogs.input({
          prompt: GITHUB_TOKEN_PROMPT,
          placeholder: 'ghp_…',
          secret: true,
        });
        if (token == null) return;
        yield* reported(
          'Failed to save GitHub token',
          storeCredential(yield* Secrets, {
            secretName: GITHUB_TOKEN_STORAGE_KEY,
            value: token,
            kind: 'github',
          }).pipe(
            Effect.andThen(notice(GITHUB_TOKEN_SAVED_MESSAGE)),
            Effect.andThen(changed('github')),
          ),
        );
      },
    ),
    removeGitHubToken: () =>
      reported(
        'Failed to remove GitHub token',
        Effect.flatMap(Secrets, (secrets) =>
          secrets.delete(GITHUB_TOKEN_STORAGE_KEY),
        ).pipe(
          Effect.andThen(notice(GITHUB_TOKEN_REMOVED_MESSAGE)),
          Effect.andThen(changed('github')),
        ),
      ),
    unsubscribePR: ({ key }) =>
      Effect.flatMap(unsubscribeGitHubKey(key), (removed) =>
        removed === 0
          ? notice(`No active subscription for ${key}.`)
          : changed('github'),
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
  return { handlers, pages };
}
