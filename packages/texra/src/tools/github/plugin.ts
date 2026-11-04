/** The GitHub activity plugin: its subscription tool and pollers, its
 *  availability check and its card. */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { Secrets } from '@texra-ai/harness/host';
import { definePlugin } from '@texra-ai/harness/plugins';
import type { TexraPlugin } from '@texra/tools/registry';
import { isGitRepository } from '@texra/utils/git/isGitRepository';
import { getGitHubToken, GITHUB_TOKEN_STORAGE_KEY } from './githubAuth';
import { GitHubSubscriptionTool } from './githubSubscriptionTool';
import {
  GITHUB_POLL_INTERVAL_MS,
  MAX_CONCURRENT_PR_SUBSCRIPTIONS,
  MAX_CONCURRENT_REPO_SUBSCRIPTIONS,
} from './prSubscriptionConstants';
import { GitHubSubscriptions } from './subscriptionBindings';
import { gitHubSubscriptionsLayer } from './subscriptionRegistries';

export const githubActivity: TexraPlugin = {
  ...definePlugin<GitHubSubscriptions>({
    // ID kept as `github-pr-subscription` for back-compat with persisted
    // disabled-tool preferences. The user-facing name has expanded to
    // cover repos and issues but the persistence key is stable.
    id: 'github-pr-subscription',
    tools: [GitHubSubscriptionTool],
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
          [getGitHubToken(secrets), isGitRepository(workspace, undefined)],
          { concurrency: 'unbounded' },
        );
        const tokenPresent = token !== undefined;
        if (tokenPresent && inGitRepo)
          return {
            available: true,
            statusDetail:
              'GitHub token detected and workspace is a git repo. Ready to subscribe to PR activity.',
          };
        if (!tokenPresent && !inGitRepo)
          return {
            available: false,
            statusLabel: 'Needs setup',
            statusDetail:
              'Open a git-tracked folder, or run git init and add a github.com remote. Then set a token in /config → GitHub token or Settings → General.',
          };
        if (!tokenPresent)
          return {
            available: false,
            statusLabel: 'Needs token',
            statusDetail:
              'This workspace is a git repo. Set a GitHub personal access token in /config → GitHub token or Settings → General to enable PR activity subscriptions.',
          };
        return {
          available: false,
          statusLabel: 'Needs git repo',
          statusDetail:
            'GitHub token is set. Open a git-tracked folder, or run git init and add a github.com remote, to use PR activity subscriptions.',
        };
      }),
    },
  }),
  card: {
    name: 'GitHub Activity Subscription',
    description:
      'Poll GitHub for pull request, issue, and repository activity. Path mirrors GitHub URL shape: "owner/repo" for coarse repo-wide events, "owner/repo/pulls/N" for per-PR comments/reviews/CI, "owner/repo/issues/N" for issue comments and lifecycle.',
    setup: {
      installGuide:
        'Requires a git-tracked workspace and a GitHub personal access token:\n\n' +
        '  1. Open the folder as a git repo (or `git init` + set a github.com remote).\n' +
        '  2. In the CLI, /config → GitHub token can store a token or open the token page with the right scopes pre-filled. In VS Code or desktop, use TeXRA Settings → General.\n' +
        '  3. Scopes: "repo" for private repositories, "public_repo" for public only.\n' +
        '  4. Store the token in host secret storage, or export GITHUB_TOKEN/GH_TOKEN for CLI and automation.',
      installUrl: 'https://github.com/settings/tokens',
      configNotes: `Token stored in host secret storage or read from GITHUB_TOKEN/GH_TOKEN. The CLI /config → GitHub token row and Settings → General in VS Code both manage the stored token. Requires a git repository in the workspace. Polls every ${GITHUB_POLL_INTERVAL_MS / 1000}s; cap: ${MAX_CONCURRENT_PR_SUBSCRIPTIONS} concurrent PRs and ${MAX_CONCURRENT_REPO_SUBSCRIPTIONS} concurrent repos. Bot-authored events are dropped end-to-end by policy.`,
      authNote: 'Uses personal access token',
    },
  },
};
