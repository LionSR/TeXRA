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
import { Effect, Layer } from 'effect';

import {
  issueKeyToString,
  IssuePollingSource,
  type IssueKey,
} from './IssuePollingSource';
import { makePollingLifetime } from './PollingSourceBase';
import {
  prKeyToString,
  PRPollingSource,
  type PRSubscribeInput,
} from './PRPollingSource';
import {
  repoKeyToString,
  RepoPollingSource,
  type RepoKey,
  type RepoSubscribeInput,
} from './RepoPollingSource';
import { RunSubscriptionRegistry } from './RunSubscriptionRegistry';
import { GitHubSubscriptions } from './subscriptionBindings';

/**
 * The GitHub subscriptions of one process runtime: the three polling sources,
 * each polling inside a lifetime this layer's scope owns, and the ownership
 * tables that bind runs to them. Releasing the layer unbinds every run and
 * then closes the sources' lifetimes, draining the deliveries they admitted,
 * so a replacement runtime starts with sources and bindings of its own.
 */
export const gitHubSubscriptionsLayer: Layer.Layer<GitHubSubscriptions> =
  Layer.effect(
    GitHubSubscriptions,
    Effect.gen(function* () {
      const pr = new PRPollingSource(yield* makePollingLifetime);
      const repo = new RepoPollingSource(yield* makePollingLifetime);
      const issue = new IssuePollingSource(yield* makePollingLifetime);
      return yield* Effect.acquireRelease(
        Effect.sync(() => ({
          pr: new RunSubscriptionRegistry<string, PRSubscribeInput>({
            name: 'PRRunSubscriptionRegistry',
            source: pr,
            keyOf: prKeyToString,
          }),
          repo: new RunSubscriptionRegistry<RepoKey, RepoSubscribeInput>({
            name: 'RepoRunSubscriptionRegistry',
            source: repo,
            keyOf: repoKeyToString,
          }),
          issue: new RunSubscriptionRegistry<string, IssueKey>({
            name: 'IssueRunSubscriptionRegistry',
            source: issue,
            keyOf: issueKeyToString,
          }),
        })),
        (registries) =>
          Effect.sync(() => {
            registries.pr.dispose();
            registries.repo.dispose();
            registries.issue.dispose();
          }),
      );
    }),
  );
