/** The GitHub activity plugin: its subscription tool and pollers, and its card. */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { definePlugin } from '@texra-ai/harness/plugins';
import { GITHUB_AVAILABILITY } from '@texra/tools/pluginAvailability';
import type { TexraPlugin } from '@texra/tools/registry';
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
    availability: GITHUB_AVAILABILITY,
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
