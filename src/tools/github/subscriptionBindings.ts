import { Context } from 'effect';

import type { IssueKey } from './IssuePollingSource';
import type { PRSubscribeInput } from './PRPollingSource';
import type { RepoKey, RepoSubscribeInput } from './RepoPollingSource';
import type { RunSubscriptionRegistry } from './RunSubscriptionRegistry';

/**
 * The three subscription registries, one per polling source, held for the
 * process by `installProcessRuntime` rather than by this module. They record
 * which runs own which subscription, so their lifetime is the runtime's: a
 * disposed runtime takes the ownership table with it instead of carrying a
 * previous process's bindings into the next one.
 *
 * Shared by the github_subscription tool (bind/unbind/list) and the settings
 * UI (list/unbindAll) so both see the same ownership. The layer that builds
 * them is `gitHubSubscriptionsLayer` in `./subscriptionRegistries`: this
 * module stays free of runtime imports so naming the service costs nothing.
 */
export class GitHubSubscriptions extends Context.Service<
  GitHubSubscriptions,
  {
    readonly pr: RunSubscriptionRegistry<string, PRSubscribeInput>;
    readonly repo: RunSubscriptionRegistry<RepoKey, RepoSubscribeInput>;
    readonly issue: RunSubscriptionRegistry<string, IssueKey>;
  }
>()('@texra/tools/GitHubSubscriptions') {}
