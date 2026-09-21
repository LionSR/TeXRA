import { Context, Layer } from 'effect';

import {
  issueKeyToString,
  SharedIssuePollingSource,
  type IssueKey,
} from './IssuePollingSource';
import {
  prKeyToString,
  SharedPRPollingSource,
  type PRSubscribeInput,
} from './PRPollingSource';
import {
  repoKeyToString,
  SharedRepoPollingSource,
  type RepoKey,
  type RepoSubscribeInput,
} from './RepoPollingSource';
import { RunSubscriptionRegistry } from './RunSubscriptionRegistry';

/**
 * The three subscription registries, one per polling source, held for the
 * process by `installProcessRuntime` rather than by this module. They record
 * which runs own which subscription, so their lifetime is the runtime's: a
 * disposed runtime takes the ownership table with it instead of carrying a
 * previous process's bindings into the next one.
 *
 * Shared by the github_subscription tool (bind/unbind/list) and the settings
 * UI (list/unbindAll) so both see the same ownership.
 */
export class GitHubSubscriptions extends Context.Service<
  GitHubSubscriptions,
  {
    readonly pr: RunSubscriptionRegistry<string, PRSubscribeInput>;
    readonly repo: RunSubscriptionRegistry<RepoKey, RepoSubscribeInput>;
    readonly issue: RunSubscriptionRegistry<string, IssueKey>;
  }
>()('@texra/tools/GitHubSubscriptions') {
  static readonly layer: Layer.Layer<GitHubSubscriptions> = Layer.sync(
    GitHubSubscriptions,
    () => ({
      pr: new RunSubscriptionRegistry<string, PRSubscribeInput>({
        name: 'PRRunSubscriptionRegistry',
        source: SharedPRPollingSource,
        keyOf: prKeyToString,
      }),
      repo: new RunSubscriptionRegistry<RepoKey, RepoSubscribeInput>({
        name: 'RepoRunSubscriptionRegistry',
        source: SharedRepoPollingSource,
        keyOf: repoKeyToString,
      }),
      issue: new RunSubscriptionRegistry<string, IssueKey>({
        name: 'IssueRunSubscriptionRegistry',
        source: SharedIssuePollingSource,
        keyOf: issueKeyToString,
      }),
    }),
  );
}
