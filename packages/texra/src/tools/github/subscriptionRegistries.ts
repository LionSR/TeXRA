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
import * as RateLimiter from 'effect/persistence/RateLimiter';

import { AppSignals } from '@texra-ai/harness';

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
export const gitHubSubscriptionsLayer: Layer.Layer<
  GitHubSubscriptions,
  never,
  AppSignals
> = Layer.effect(
  GitHubSubscriptions,
  Effect.gen(function* () {
    const lifetimes = [
      yield* makePollingLifetime,
      yield* makePollingLifetime,
      yield* makePollingLifetime,
    ] as const;
    const limiter = yield* RateLimiter.RateLimiter;
    const signals = yield* AppSignals;
    // Bound annotation endpoint traffic across all PR subscriptions in this
    // process: one unit per annotations page, at most 3,000 requests per
    // hour, leaving room for the other PR polling endpoints under GitHub's
    // primary 5,000/hour limit. Independent of the poll interval.
    const claimAnnotation = limiter
      .consume({
        algorithm: 'token-bucket',
        onExceeded: 'fail',
        window: '1 minute',
        limit: 50,
        key: 'github-annotations',
      })
      .pipe(Effect.asVoid);
    // Each registry releases its bindings in this scope, after the
    // lifetimes opened above, so it closes before they do.
    return {
      pr: yield* RunSubscriptionRegistry.make<string, PRSubscribeInput>({
        name: 'PRRunSubscriptionRegistry',
        source: new PRPollingSource(lifetimes[0], claimAnnotation),
        keyOf: prKeyToString,
        signals,
      }),
      repo: yield* RunSubscriptionRegistry.make<RepoKey, RepoSubscribeInput>({
        name: 'RepoRunSubscriptionRegistry',
        source: new RepoPollingSource(lifetimes[1]),
        keyOf: repoKeyToString,
        signals,
      }),
      issue: yield* RunSubscriptionRegistry.make<string, IssueKey>({
        name: 'IssueRunSubscriptionRegistry',
        source: new IssuePollingSource(lifetimes[2]),
        keyOf: issueKeyToString,
        signals,
      }),
      drainDeliveries: Effect.forEach(lifetimes, (lifetime) => lifetime.drain, {
        concurrency: 'unbounded',
        discard: true,
      }),
    };
  }),
).pipe(
  Layer.provide(
    RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
  ),
);
