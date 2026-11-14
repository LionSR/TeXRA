/**
 * The polling fiber of one subscription target, and the pieces every target
 * kind's poll shares.
 *
 * A kind supplies `poll(prior)`: its GET requests read with the previous
 * state, and a fold of the responses into the next state and the events to
 * report. `undefined` is the state before the first poll: that poll records
 * cursors and reports nothing, so history from before the subscription is
 * never replayed. The fiber keeps the state, writes it once per poll after
 * the whole poll succeeded, and publishes that poll's events; a failed poll
 * leaves the state as it was, so the next one asks GitHub the same questions.
 */

// Third-party imports
import { Clock, Duration, Effect, Random, Ref, Schedule, Schema } from 'effect';
import { LRUCache } from 'lru-cache';

// Local imports
import {
  jitteredExponentialBackoffMs,
  emitAppSignal,
  withLogChannel,
  type AppSignals,
} from '@texra-ai/harness/plugins';
import { shouldDropBotEvent } from './botFilter';
import type { GitHubCheckAnnotationLevel } from './checkAnnotationLevels';
import { formatSubscriptionHalted } from './formatUtils';
import {
  ghGet,
  type ConditionalResponse,
  type GitHubFailure,
  type GitHubServices,
} from './githubClient';
import { getNewestTimestamp } from './githubPaths';
import { GITHUB_POLL_INTERVAL_MS } from './prSubscriptionConstants';
import type { GhUser } from './prTypes';
import { targetPath, type SubscriptionTarget } from './subscriptionTarget';

/**
 * One message for the runs bound to a target, or one whose text depends on a
 * run's lowest check-annotation level (`undefined`: nothing for that run).
 */
export type PollEvent =
  | string
  | ((minAnnotationLevel: GitHubCheckAnnotationLevel) => string | undefined);

/** What one successful poll of a target produced. */
export interface PollResult<S> {
  readonly next: S | undefined;
  readonly events: readonly PollEvent[];
  /** The target can produce no more activity (a closed pull request): its
   *  last event says so, and its runs are unbound. */
  readonly ended?: boolean;
}

/** First retry delay after a failed poll; doubles per consecutive failure. */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
/** A target with no successful poll for this long is dropped. */
const MAX_FAILURE_DURATION_MS = 24 * 3_600_000;

interface PollHealth<S> {
  readonly state: S | undefined;
  /** The last successful poll; the 24 h gate compares against it. */
  readonly lastSuccessAt: number;
  readonly consecutiveFailures: number;
}

/**
 * Poll `target` every {@link GITHUB_POLL_INTERVAL_MS}, publishing each poll's
 * events, until the target ends or its subscription halts: the token is
 * rejected (which also raises `githubTokenInvalid`), GitHub says the target
 * is gone, it stays unreachable for a day, or the poll has a bug. A halt
 * publishes the message that says why. Rate limits wait until GitHub's
 * reset; other failures back off exponentially. The last events go through
 * `finish` instead of `publish`: it unbinds the target's runs and delivers to
 * them in one step, so a run that binds after it starts a new subscription.
 */
export const pollTarget = Effect.fn('github.pollTarget')(function* <S, R>(
  target: SubscriptionTarget,
  poll: (
    prior: S | undefined,
  ) => Effect.Effect<PollResult<S>, GitHubFailure, R>,
  publish: (events: readonly PollEvent[]) => Effect.Effect<void>,
  finish: (
    events: readonly PollEvent[],
  ) => Effect.Effect<void, never, AppSignals>,
) {
  const path = targetPath(target);
  const halt = (detail: string) =>
    finish([formatSubscriptionHalted(target, detail)]).pipe(Effect.as(false));
  const health = yield* Ref.make<PollHealth<S>>({
    state: undefined,
    lastSuccessAt: yield* Clock.currentTimeMillis,
    consecutiveFailures: 0,
  });

  /** One poll; whether polling continues. */
  const round = Effect.gen(function* () {
    const prior = yield* Ref.get(health);
    const retryLater = (error: Error) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const failureCount = prior.consecutiveFailures + 1;
        if (now - prior.lastSuccessAt >= MAX_FAILURE_DURATION_MS) {
          yield* logWarning(
            `Poll failed for ${path}; unreachable for over 24 h, detaching.`,
            { failureCount, error },
          );
          return yield* halt('unreachable for over 24 h; detaching');
        }
        yield* Ref.set(health, {
          ...prior,
          consecutiveFailures: failureCount,
        });
        // Jittered +/-20% so a network outage doesn't stampede every
        // subscription back at exactly the same moment.
        const delayMs = jitteredExponentialBackoffMs(
          BACKOFF_BASE_MS,
          failureCount,
          BACKOFF_MAX_MS,
          yield* Random.next,
        );
        yield* logWarning(`Poll failed for ${path}; retrying.`, {
          failureCount,
          retryInSec: Math.round(delayMs / 1000),
          error,
        });
        yield* Effect.sleep(Duration.millis(delayMs));
        return true;
      });

    return yield* poll(prior.state).pipe(
      Effect.flatMap((result) =>
        Effect.gen(function* () {
          yield* Ref.set(health, {
            state: result.next,
            lastSuccessAt: yield* Clock.currentTimeMillis,
            consecutiveFailures: 0,
          });
          if (result.ended === true) {
            yield* finish(result.events);
            return false;
          }
          yield* publish(result.events);
          return true;
        }),
      ),
      Effect.catchTags({
        GitHubAuthError: (err) =>
          logWarning(
            `Auth error for ${path}; stopping subscription.`,
            err,
          ).pipe(
            Effect.andThen(halt(err.message)),
            Effect.tap(
              emitAppSignal('githubTokenInvalid', { message: err.message }),
            ),
          ),
        GitHubPermanentError: (err) =>
          logWarning(
            `Permanent error for ${path}; stopping subscription.`,
            err,
          ).pipe(Effect.andThen(halt(err.message))),
        GitHubRateLimitError: (err) =>
          Effect.gen(function* () {
            // A rate-limit wait neither resets the 24 h window nor counts
            // toward backoff, but a target limited for a whole day still
            // ages out rather than holding its slot.
            const now = yield* Clock.currentTimeMillis;
            if (now - prior.lastSuccessAt >= MAX_FAILURE_DURATION_MS) {
              yield* logWarning(
                `Rate limited polling ${path} and unreachable for over 24 h; detaching.`,
              );
              return yield* halt('unreachable for over 24 h; detaching');
            }
            const resetAtMs = err.resetAt * 1000;
            yield* logWarning(
              `Rate limited polling ${path}; backing off until ${new Date(resetAtMs).toISOString()}.`,
            );
            yield* Effect.sleep(Duration.millis(Math.max(0, resetAtMs - now)));
            return true;
          }),
        GitHubTransientError: (err) => retryLater(err),
        SecretsFailed: (err) => retryLater(err),
      }),
    );
  });

  yield* Effect.repeat(round, {
    schedule: Schedule.fixed(Duration.millis(GITHUB_POLL_INTERVAL_MS)),
    while: (keepPolling) => keepPolling,
  }).pipe(
    // A bug in one target's poll ends that target's subscription, said to
    // its runs, instead of retrying the same bug every interval.
    Effect.catchDefect((defect) =>
      logWarning(
        `Poll of ${path} threw a defect; stopping subscription.`,
        defect,
      ).pipe(Effect.andThen(halt('stopped by an internal error'))),
    ),
    withLogChannel(`github.${target._tag}`),
  );
});

/**
 * Warn on the polling fiber's channel. A `data` argument, when given, rides
 * the entry raw as its payload; omitting it leaves the entry without one.
 */
export function logWarning(
  message: string,
  ...data: [] | [unknown]
): Effect.Effect<void> {
  const entry = Effect.logWarning(message);
  return data.length === 0
    ? entry
    : Effect.annotateLogs(entry, { data: data[0] });
}

/**
 * A poll's GET: {@link ghGet}, reading a malformed 200 body as unchanged with
 * a warning. GitHub answered, so a bad body skips the resource it feeds for
 * this poll instead of counting as a failed poll that would eventually drop a
 * reachable target; like a 304 it leaves the resource's ETag and cursor
 * where they were, so the next poll reads it again.
 */
export function pollGet<T>(
  path: string,
  schema: Schema.Codec<T, unknown>,
  etag?: string,
): Effect.Effect<ConditionalResponse<T>, GitHubFailure, GitHubServices> {
  return ghGet(path, schema, etag).pipe(
    Effect.catchTag('GitHubMalformedBodyError', (error) =>
      logWarning(`Skipping ${path} this poll: malformed body`, error).pipe(
        Effect.as({ status: 304 } as const),
      ),
    ),
  );
}

/** A copy of `cache` with the same capacity, entries and recency order. */
export function copyLru<
  K extends NonNullable<unknown>,
  V extends NonNullable<unknown>,
>(cache: LRUCache<K, V>): LRUCache<K, V> {
  const copy = new LRUCache<K, V>({ max: cache.max });
  copy.load(cache.dump());
  return copy;
}

/** How many delivered ids a list resource remembers, so a long-running
 *  subscription does not grow its history without bound. */
const MAX_SEEN_IDS = 1000;

/** The ids a list resource has delivered, and the newest timestamp among
 *  its items: the cursor its next poll reads from. A poll builds the next
 *  one and never changes the one it read. */
export interface SeenItems {
  readonly ids: LRUCache<number, true>;
  readonly sinceCursor: string | undefined;
}

/**
 * A list resource's next dedup state and the new items to report from one
 * response. `seen` is `undefined` until a 200 has been read: that first list
 * is only recorded, with `seedCursor` as its cursor until an item names a
 * newer one. Bot-authored items are recorded but not reported.
 */
export function readNewItems<
  T extends {
    readonly id: number;
    readonly user: GhUser | null | undefined;
    readonly created_at?: string | null;
    readonly updated_at?: string | null;
  },
>(
  seen: SeenItems | undefined,
  res: ConditionalResponse<readonly T[]>,
  seedCursor?: string,
): { readonly seen: SeenItems | undefined; readonly fresh: T[] } {
  if (res.status !== 200) return { seen, fresh: [] };
  const fresh: T[] = [];
  let ids: LRUCache<number, true>;
  if (seen === undefined) {
    ids = new LRUCache({ max: MAX_SEEN_IDS });
    for (const item of res.data) ids.set(item.id, true);
  } else {
    ids = copyLru(seen.ids);
    // Classify the whole batch against pre-batch membership before adding
    // anything, so an eviction triggered partway through this tick can't
    // make an id already seen this tick look "new" again (`newIds` also
    // catches the same id appearing twice within one fetched page).
    const newIds = new Set<number>();
    for (const item of res.data) {
      if (ids.has(item.id) || newIds.has(item.id)) continue;
      newIds.add(item.id);
      if (!shouldDropBotEvent(item.user)) fresh.push(item);
    }
    for (const id of newIds) ids.set(id, true);
  }
  const sinceCursor =
    getNewestTimestamp(res.data) ?? seen?.sinceCursor ?? seedCursor;
  return { seen: { ids, sinceCursor }, fresh };
}
