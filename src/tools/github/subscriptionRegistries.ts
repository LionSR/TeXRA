/**
 * The three registries behind {@link GitHubSubscriptions}, built once by the
 * process runtime that provides the tag.
 *
 * They live apart from the tag because building one reaches the polling
 * sources and, through {@link RunSubscriptionRegistry}, the follow-up queue:
 * a module that only has to name the service — a composition root's type, a
 * test harness's stand-in — imports `subscriptionBindings` and loads none of
 * that graph.
 */
import { Layer } from 'effect';

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
import { GitHubSubscriptions } from './subscriptionBindings';

/** The ownership tables of one process runtime. */
export const gitHubSubscriptionsLayer: Layer.Layer<GitHubSubscriptions> =
  Layer.sync(GitHubSubscriptions, () => ({
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
  }));
