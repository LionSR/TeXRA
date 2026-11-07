/**
 * The layer behind {@link GitHubSubscriptions}, built once by the process
 * runtime that provides the tag.
 *
 * It lives apart from the tag because building it reaches the pollers and
 * the follow-up queue: a module that only has to name the service (a
 * composition root's type, a test harness's stand-in) imports
 * `subscriptionBindings` and loads none of that graph.
 */

// Third-party imports
import { Effect, Exit, FiberMap, FiberSet, Layer, Option, Scope } from 'effect';
import * as RateLimiter from 'effect/persistence/RateLimiter';

// Local imports
import {
  AppSignals,
  emitAppSignal,
  SESSION_CLOSE_DEADLINE_MS,
  withLogChannel,
} from '@texra-ai/harness/host';
import { ToolError, type RunInbox } from '@texra-ai/harness/plugins';
import type { RunId } from '@texra-ai/harness/schemas';

import type { GitHubCheckAnnotationLevel } from './checkAnnotationLevels';
import type { GitHubServices } from './githubClient';
import { pollIssue, type IssueState } from './issuePoller';
import { pollTarget, type PollEvent } from './poller';
import { MAX_SUBSCRIPTIONS } from './prSubscriptionConstants';
import { pollPull, type PullState } from './pullPoller';
import { pollRepo, type RepoState } from './repoPoller';
import { GitHubSubscriptions } from './subscriptionBindings';
import {
  TARGET_LABEL,
  targetPath,
  type SubscriptionTarget,
} from './subscriptionTarget';

/** One run's binding to a target. A rebind replaces its fields. */
interface Binding {
  inbox: RunInbox;
  minAnnotationLevel: GitHubCheckAnnotationLevel;
  /** Stops hearing {@link inbox} close. */
  stopHearingClose: () => void;
}

/** A subscribed target and the runs bound to it, never empty. */
interface Subscription {
  readonly target: SubscriptionTarget;
  readonly runs: Map<RunId, Binding>;
}

const inLogChannel = withLogChannel('github');

const bindingsChanged = emitAppSignal('githubSubscriptionsChanged', undefined);

/**
 * The GitHub subscriptions of one process runtime. Each subscribed target
 * has one polling fiber, keyed by the target's path, that delivers its
 * events to the runs bound to it at the time; the last run's unbind stops
 * it, and a target that ends on its own (a closed PR, a rejected token)
 * drops its runs. Releasing the layer unbinds every run, stops polling and
 * drains the deliveries already made, so a replacement runtime starts with
 * subscriptions of its own.
 */
export const gitHubSubscriptionsLayer: Layer.Layer<
  GitHubSubscriptions,
  never,
  AppSignals
> = Layer.effect(
  GitHubSubscriptions,
  Effect.gen(function* () {
    const limiter = yield* RateLimiter.RateLimiter;
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

    // The pollers and the deliveries live in scopes of their own, so the
    // shutdown drain can stop polling first and let the deliveries already
    // made reach their runs within a budget; a delivery stuck past it is
    // interrupted, and says so.
    const pollScope = yield* Scope.make();
    const pollers = yield* FiberMap.make<string>().pipe(
      Effect.provideService(Scope.Scope, pollScope),
    );
    const deliveryScope = yield* Scope.make();
    const deliveries = yield* FiberSet.make<void>().pipe(
      Effect.provideService(Scope.Scope, deliveryScope),
    );
    const drainDeliveries = Scope.close(pollScope, Exit.void).pipe(
      Effect.andThen(
        FiberSet.awaitEmpty(deliveries).pipe(
          Effect.timeoutOption(SESSION_CLOSE_DEADLINE_MS),
        ),
      ),
      Effect.flatMap((drained) =>
        Option.isSome(drained)
          ? Effect.void
          : Effect.logWarning(
              'GitHub deliveries did not finish within the close budget; interrupting them',
            ),
      ),
      Effect.ensuring(Scope.close(deliveryScope, Exit.void)),
    );
    yield* Effect.addFinalizer(() => drainDeliveries);
    // Unbinds a run whose inbox closed: the close is heard outside any fiber.
    const closeListeners = yield* FiberSet.make<void>();

    /** By target path. */
    const subscriptions = new Map<string, Subscription>();
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const removed = [...subscriptions.values()];
        subscriptions.clear();
        for (const subscription of removed) stopHearing(subscription);
        return removed.length > 0 ? bindingsChanged : Effect.void;
      }),
    );

    const deliver = (
      path: string,
      runId: RunId,
      inbox: RunInbox,
      text: string,
    ): Effect.Effect<void> => {
      // The identifiers ride in the message: the sink renders `data` with
      // sorted keys under a length bound, so beside an error's stack they
      // would be the part truncated away.
      const reportFailure = (err: unknown) =>
        Effect.logWarning(
          `Failed to deliver subscription follow-up for ${path} (run ${runId})`,
        ).pipe(Effect.annotateLogs({ data: { err } }), inLogChannel);
      return inbox
        .send({ text, from: { kind: 'notification', source: 'github' } })
        .pipe(
          Effect.asVoid,
          Effect.catch(reportFailure),
          Effect.catchDefect(reportFailure),
        );
    };

    /** Deliver `events` to `runs` now, each as its own fiber in the drained set. */
    const deliverTo = (
      path: string,
      runs: ReadonlyMap<RunId, Binding>,
      events: readonly PollEvent[],
    ): Effect.Effect<void> =>
      Effect.forEach(
        [...runs],
        ([runId, binding]) =>
          Effect.forEach(
            events,
            (event) => {
              const text =
                typeof event === 'string'
                  ? event
                  : event(binding.minAnnotationLevel);
              return text === undefined
                ? Effect.void
                : FiberSet.run(
                    deliveries,
                    deliver(path, runId, binding.inbox, text),
                  );
            },
            { discard: true },
          ),
        { discard: true },
      );

    /** The target's polling fiber. Its last events end the subscription:
     *  the runs are unbound and told in one step, so a bind that lands
     *  meanwhile either is told too or starts a subscription of its own. */
    const pollerOf = (
      target: SubscriptionTarget,
    ): Effect.Effect<void, never, GitHubServices | AppSignals> => {
      const path = targetPath(target);
      const publish = (events: readonly PollEvent[]) =>
        Effect.suspend(() => {
          const subscription = subscriptions.get(path);
          return subscription?.target === target
            ? deliverTo(path, subscription.runs, events)
            : Effect.void;
        });
      const finish = (events: readonly PollEvent[]) =>
        Effect.suspend(() => {
          const subscription = subscriptions.get(path);
          if (subscription?.target !== target) return Effect.void;
          subscriptions.delete(path);
          stopHearing(subscription);
          return deliverTo(path, subscription.runs, events).pipe(
            Effect.andThen(
              Effect.logInfo(`Subscription to ${path} ended`).pipe(
                inLogChannel,
              ),
            ),
            Effect.andThen(bindingsChanged),
          );
        });
      return target._tag === 'pull'
        ? pollTarget(
            target,
            (prior: PullState | undefined) =>
              pollPull(target, claimAnnotation, prior),
            publish,
            finish,
          )
        : target._tag === 'issue'
          ? pollTarget(
              target,
              (prior: IssueState | undefined) => pollIssue(target, prior),
              publish,
              finish,
            )
          : pollTarget(
              target,
              (prior: RepoState | undefined) => pollRepo(target, prior),
              publish,
              finish,
            );
    };

    /** Remove `runIds`' bindings to `path`, stopping its polling once no
     *  run is left; answers how many were removed. */
    const removeBindings = (
      path: string,
      runIds: (subscription: Subscription) => readonly RunId[],
    ): Effect.Effect<number, never, AppSignals> =>
      Effect.suspend(() => {
        const subscription = subscriptions.get(path);
        if (subscription === undefined) return Effect.succeed(0);
        let removed = 0;
        for (const runId of runIds(subscription)) {
          const binding = subscription.runs.get(runId);
          if (binding === undefined) continue;
          subscription.runs.delete(runId);
          binding.stopHearingClose();
          removed += 1;
        }
        if (removed === 0) return Effect.succeed(0);
        let stopPolling: Effect.Effect<void> = Effect.void;
        if (subscription.runs.size === 0) {
          subscriptions.delete(path);
          stopPolling = FiberMap.remove(pollers, path).pipe(
            Effect.andThen(
              Effect.logInfo(`Unsubscribed from ${path}`).pipe(inLogChannel),
            ),
          );
        }
        return stopPolling.pipe(
          Effect.andThen(bindingsChanged),
          Effect.as(removed),
        );
      });

    const unbind = (runId: RunId, target: SubscriptionTarget) =>
      removeBindings(targetPath(target), () => [runId]).pipe(
        Effect.map((removed) => removed > 0),
      );

    // Uninterruptible, so a recorded subscription always has its poller.
    const bind = Effect.fn('GitHubSubscriptions.bind')(function* (
      runId: RunId,
      target: SubscriptionTarget,
      inbox: RunInbox,
      minAnnotationLevel: GitHubCheckAnnotationLevel,
    ) {
      const path = targetPath(target);
      const hearClose = yield* FiberSet.runtime(closeListeners)<AppSignals>();
      const listen = () =>
        inbox.onClosed(() => {
          hearClose(unbind(runId, target));
        });
      const subscription = subscriptions.get(path);
      const existing = subscription?.runs.get(runId);
      if (existing) {
        existing.stopHearingClose();
        existing.inbox = inbox;
        existing.minAnnotationLevel = minAnnotationLevel;
        existing.stopHearingClose = listen();
        return false;
      }
      if (subscription === undefined) {
        const cap = MAX_SUBSCRIPTIONS[target._tag];
        const active = [...subscriptions.values()].filter(
          (other) => other.target._tag === target._tag,
        ).length;
        if (active >= cap) {
          return yield* Effect.fail(
            new ToolError(
              `Too many active ${TARGET_LABEL[target._tag]} subscriptions (max ${cap}). Unsubscribe from one before adding another.`,
            ),
          );
        }
      }
      const bound = subscription ?? { target, runs: new Map() };
      bound.runs.set(runId, {
        inbox,
        minAnnotationLevel,
        stopHearingClose: listen(),
      });
      if (subscription === undefined) {
        subscriptions.set(path, bound);
        // Forked from this call, the poller runs on the caller's GitHub
        // services; the map holds it, not the call.
        yield* FiberMap.run(pollers, path, pollerOf(target));
        yield* Effect.logInfo(`Subscribed to ${path}`).pipe(inLogChannel);
      }
      yield* Effect.logInfo(`Bound subscription ${path} → run ${runId}`).pipe(
        inLogChannel,
      );
      yield* bindingsChanged;
      return true;
    }, Effect.uninterruptible);

    return {
      bind,
      unbind,
      unbindAll: (target) =>
        removeBindings(targetPath(target), (subscription) => [
          ...subscription.runs.keys(),
        ]),
      list: Effect.sync(() =>
        [...subscriptions.values()].map((subscription) => ({
          target: subscription.target,
          runIds: [...subscription.runs.keys()],
        })),
      ),
      drainDeliveries,
    };
  }),
).pipe(
  Layer.provide(
    RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
  ),
);

function stopHearing(subscription: Subscription): void {
  for (const binding of subscription.runs.values()) binding.stopHearingClose();
}
