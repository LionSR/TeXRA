/** The GitHub activity plugin: its subscription tool and pollers, its
 *  availability check and its card. */

// Third-party imports
import { Duration, Effect } from 'effect';

// Local imports
import { definePlugin, Secrets } from '@texra-ai/worldline/plugins';
import type { TexraPlugin } from '@texra/tools/registry';
import { texraPlugin } from '@texra/tools/texraPlugin';
import { isGitRepository } from '@texra-ai/worldline/node';
import { getGitHubToken, GITHUB_TOKEN_STORAGE_KEY } from './githubAuth';
import { GitHubSubscriptionTool } from './githubSubscriptionTool';
import {
  GITHUB_POLL_INTERVAL_MS,
  MAX_SUBSCRIPTIONS,
} from './prSubscriptionConstants';
import { GitHubSubscriptions } from './subscriptionBindings';
import { gitHubSubscriptionsLayer } from './subscriptionsLayer';

export const githubActivity: TexraPlugin = texraPlugin({
  ...definePlugin<GitHubSubscriptions>({
    // ID kept as `github-pr-subscription` for back-compat with persisted
    // disabled-tool preferences. The user-facing name has expanded to
    // cover repos and issues but the persistence key is stable.
    id: 'github-pr-subscription',
    tools: [GitHubSubscriptionTool],
    prompt: ({ offered }) =>
      offered.includes('github_subscription')
        ? 'Use `github_subscription` when the user asks you to follow up on review comments or CI of a pull request.'
        : '',
    toggle: 'off',
    processLayer: {
      layer: gitHubSubscriptionsLayer,
      // Its step of the core shutdown protocol.
      drain: Effect.flatMap(GitHubSubscriptions, (s) => s.drainDeliveries),
    },
    availability: {
      // The token gates the tool, so a change re-probes every held
      // workspace.
      reprobeOnSecrets: [GITHUB_TOKEN_STORAGE_KEY],
      check: Effect.fn('github.availability')(function* ({ workspace }) {
        const secrets = yield* Secrets;
        // The token read and the git probe run at once. The probe reports
        // "not a repository" as `false` and never fails; interrupting a
        // dashboard refresh kills its `git` process instead of abandoning it.
        const [token, inGitRepo] = yield* Effect.all(
          [getGitHubToken(secrets), isGitRepository(workspace)],
          { concurrency: 'unbounded' },
        );
        const tokenPresent = token !== undefined;
        if (tokenPresent && inGitRepo)
          return {
            available: true,
            statusDetail: 'GitHub token and git repository ready.',
          };
        if (!tokenPresent && !inGitRepo)
          return {
            available: false,
            statusLabel: 'Needs setup',
            statusDetail:
              'Open a git repository with a github.com remote, then add a token in Settings → General → Git (or /config → GitHub token).',
          };
        if (!tokenPresent)
          return {
            available: false,
            statusLabel: 'Needs token',
            statusDetail:
              'Add a GitHub personal access token in Settings → General → Git (or /config → GitHub token).',
          };
        return {
          available: false,
          statusLabel: 'Needs git repo',
          statusDetail:
            'Open a git repository with a github.com remote to subscribe to PR activity.',
        };
      }),
    },
  }),
  dashboard: {
    name: 'GitHub Activity Subscription',
    description:
      'Watch GitHub repositories, pull requests, and issues for new comments, reviews, and CI updates.',
    setup: {
      installGuide:
        'Requires a git repository with a github.com remote and a GitHub personal access token:\n\n' +
        '  1. Add a token in Settings → General → Git (or /config → GitHub token in the CLI), or export GITHUB_TOKEN / GH_TOKEN.\n' +
        '  2. Scopes: "repo" for private repositories, "public_repo" for public only.',
      installUrl: 'https://github.com/settings/tokens',
      configNotes: `Polls every ${Duration.format(Duration.millis(GITHUB_POLL_INTERVAL_MS))} (up to ${MAX_SUBSCRIPTIONS.pull} PRs and ${MAX_SUBSCRIPTIONS.repo} repos). Bot events are ignored.`,
      authNote: 'Uses personal access token',
    },
  },
});
