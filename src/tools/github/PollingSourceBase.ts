/**
 * Shared lifecycle, error handling, and timer management for the GitHub
 * polling sources.
 *
 * Subclasses implement only `pollOne()` — the actual endpoints to hit and
 * per-tick state to mutate — plus the error-formatting hook that names the
 * subscription type. Everything around it
 * (subscribe/unsubscribe, change-listener fan-out, the poll loop,
 * classification of GitHub errors into auth /
 * permanent / rate-limit / transient, jittered exponential backoff, and the
 * 24 h detach gate) lives here once.
 *
 * The subscribe path is Effect-typed end to end (`register` →
 * `StreamSubscriptionRegistry.bind` → the tool's `execute()` runs it, R1);
 * this module holds no `Effect.run*` call. Listener fan-out returns delivery
 * programs that the emit turn forks detached ({@link PollEventListener}), so
 * a slow listener never stalls a poll round.
 */

import {
  Cause,
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Schedule,
} from 'effect';

import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { appSignals } from '@eventBus/AppSignals';

import {
  SHUTDOWN_PHASE,
  type Disposable,
  type LifecycleHost,
} from '@platform/interfaces';
import { platform } from '@platform/platform';
import { jitteredExponentialBackoffMs } from '@utils/core';
import {
  createBoundedIdSet,
  type BoundedIdSet,
} from '@utils/core/boundedIdSet';
import { getNewestTimestamp } from './githubPaths';
import {
  type ConditionalResponse,
  GitHubAuthError,
  GitHubPermanentError,
  GitHubRateLimitError,
} from './githubClient';
import { shouldDropBotEvent } from './botFilter';
import type { GhUser } from './prTypes';
import type { ZodType } from 'zod';

/**
 * A subscription event listener. The poller invokes it synchronously on the
 * emitting turn — so any state the delivery depends on is captured with the
 * emit, not with a later scheduler turn — and forks the returned program
 * detached, the fire-and-forget shape the old `(text) => void` Promise
 * listeners had. The program must recover its own failures and defects;
 * `emitToListener` guards only the synchronous invocation itself.
 */
export type PollEventListener = (text: string) => Effect.Effect<void>;

export interface BasePollSubscriptionState {
  listeners: Set<PollEventListener>;
  /** Most recent successful poll. The 24 h detach gate compares against this. */
  lastSuccessAt: number;
  consecutiveFailures: number;
  /** Epoch-ms until which this subscription skips polling (rate-limit or backoff). */
  skipPollUntilMs: number;
}

/**
 * The four invariant fields every `createInitialState()` populates identically.
 * Spread into a subscription state so the base shape stays canonical here
 * instead of copy-pasted across each poller.
 */
export function createBasePollState(
  now = Date.now(),
): BasePollSubscriptionState {
  return {
    listeners: new Set(),
    lastSuccessAt: now,
    consecutiveFailures: 0,
    skipPollUntilMs: 0,
  };
}

/**
 * A subclass hook (`pollOne` or `afterTick`) failed. `cause` is whatever the
 * GitHub call raised — one of the GitHub error classes or a transport
 * failure that {@link PollingSourceBase.handleFailure} classifies. It is the
 * only failure a poll hook may report, so the base can classify every one of
 * them without inspecting a wider channel.
 */
export class PollHookRejected extends Data.TaggedError('PollHookRejected')<{
  readonly cause: unknown;
}> {}

/**
 * The one wrap of the GitHub client for a poll hook: a rejected request
 * becomes a {@link PollHookRejected} carrying the error the client raised, so
 * `handleFailure`'s `instanceof` classification still sees the GitHub error
 * class itself.
 */
export const pollRequest = <A>(
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, PollHookRejected> =>
  Effect.tryPromise({
    try: request,
    catch: (cause) => new PollHookRejected({ cause }),
  });

/**
 * The ambient clock with a sleep that does not hold the event loop.
 *
 * The poll loop sleeps between rounds, and the process clock's sleep
 * schedules a referenced timer, so the loop alone would keep a short-lived
 * host (the CLI) alive until shutdown interrupted it. This clock is what the
 * loop sleeps on: the same readings as the clock in scope, a timer the loop
 * does not wait for, still interrupted through the clock rather than a timer
 * handle this class holds. It replaces the `setInterval` + `timer.unref()`
 * pair this file used to keep off Effect's clock.
 */
function unrefSleepClock(clock: Clock.Clock): Clock.Clock {
  return {
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const handle = setTimeout(
          () => resume(Effect.void),
          Duration.toMillis(duration),
        );
        handle.unref?.();
        return Effect.sync(() => clearTimeout(handle));
      }),
  };
}

interface PollingSourceConfig {
  /** Display name used in the logger and exception messages. */
  name: string;
  pollIntervalMs: number;
  maxConcurrent: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxFailureDurationMs: number;
}

type SuccessfulConditionalResponse<T> = Extract<
  ConditionalResponse<T>,
  { status: 200 }
>;

export const DEFAULT_POLLING_BACKOFF_CONFIG = Object.freeze({
  backoffBaseMs: 60_000,
  backoffMaxMs: 3_600_000,
  maxFailureDurationMs: 24 * 3_600_000,
} satisfies Pick<
  PollingSourceConfig,
  'backoffBaseMs' | 'backoffMaxMs' | 'maxFailureDurationMs'
>);

interface DedupedResourceOptions<T, Id> {
  getId(item: T): Id;
  getCursor?(items: readonly T[]): string | undefined;
  maxSeenIds: number;
  sinceCursor?: string;
}

export class DedupedResource<T, Id extends NonNullable<unknown> = number> {
  readonly seenIds: BoundedIdSet<Id>;
  sinceCursor: string | undefined;

  private readonly getId: (item: T) => Id;
  private readonly getCursor:
    ((items: readonly T[]) => string | undefined) | undefined;

  constructor(options: DedupedResourceOptions<T, Id>) {
    this.getId = options.getId;
    this.getCursor = options.getCursor;
    this.sinceCursor = options.sinceCursor;
    this.seenIds = createBoundedIdSet<Id>(options.maxSeenIds);
  }

  seed(items: readonly T[]): void {
    for (const item of items) {
      this.seenIds.add(this.getId(item));
    }
    this.advanceCursor(items);
  }

  diff(items: readonly T[], emit: (item: T) => void): void {
    // Classify the whole batch against pre-batch membership before adding
    // anything, so an eviction triggered partway through this tick can't
    // make an id already seen this tick look "new" again (`newIds` also
    // catches the same id appearing twice within one fetched page).
    const newIds = new Set<Id>();
    for (const item of items) {
      const id = this.getId(item);
      if (this.seenIds.has(id) || newIds.has(id)) continue;
      newIds.add(id);
      emit(item);
    }
    for (const id of newIds) this.seenIds.add(id);
    this.advanceCursor(items);
  }

  private advanceCursor(items: readonly T[]): void {
    const newest = this.getCursor?.(items);
    if (newest) this.sinceCursor = newest;
  }
}

/**
 * Per-resource id history is trimmed to this many entries so long-running
 * subscriptions don't grow the dedup set unboundedly. Shared by every
 * comment-shaped poller (issue comments, PR review comments, repo-wide
 * issue/review comments).
 */
export const MAX_SEEN_IDS = 1000;

interface CommentShape {
  id: number;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Build a {@link DedupedResource} for comment-shaped items, hardcoding the
 * three options every comment poller agrees on: id-keyed dedup, newest-
 * timestamp cursor advance (via {@link getNewestTimestamp}), and the shared
 * {@link MAX_SEEN_IDS} window. Callers pass only an optional seed cursor.
 */
export function dedupeComments<T extends CommentShape>(options?: {
  sinceCursor?: string;
}): DedupedResource<T> {
  return new DedupedResource<T>({
    getId: (item) => item.id,
    getCursor: getNewestTimestamp,
    maxSeenIds: MAX_SEEN_IDS,
    sinceCursor: options?.sinceCursor,
  });
}

/**
 * `K` is the canonical string key (PR keys flatten to `owner/repo#N`,
 * repo keys are `owner/repo`); `S` is the per-subscription state object,
 * which must extend `BasePollSubscriptionState`.
 */
export abstract class PollingSourceBase<
  K extends string,
  S extends BasePollSubscriptionState,
> {
  protected readonly logger: AgentTrace;
  private readonly subscriptions = new Map<K, S>();
  private readonly keysChangedListeners = new Set<
    (keys: readonly K[]) => void
  >();
  /** The stop request for the owned poll loop; absent while it is stopped. */
  private pollLoopStop: Deferred.Deferred<void> | undefined;
  private shutdownRegistration: Disposable | undefined;
  private shutdownLifecycle: LifecycleHost | undefined;

  constructor(protected readonly config: PollingSourceConfig) {
    this.logger = createChannelTrace(config.name);
  }

  /** Subclass: poll the endpoints for one subscription and emit any new events. */
  protected abstract pollOne(
    key: K,
    state: S,
  ): Effect.Effect<void, PollHookRejected>;

  /** Optional subclass hook that runs after all subscription polls settle. */
  protected afterTick(
    _entries: ReadonlyArray<readonly [K, S]>,
    _now: number,
  ): Effect.Effect<void, PollHookRejected> {
    return Effect.void;
  }

  /** Subclass: format a halted-subscription error event for the listener. */
  protected abstract formatErrorEvent(state: S, detail: string): string;

  activeKeys(): readonly K[] {
    return [...this.subscriptions.keys()];
  }

  protected getSubscriptionState(key: K): S | undefined {
    return this.subscriptions.get(key);
  }

  has(key: K): boolean {
    return this.subscriptions.has(key);
  }

  onKeysChanged(listener: (keys: readonly K[]) => void): Disposable {
    this.keysChangedListeners.add(listener);
    return {
      dispose: () => {
        this.keysChangedListeners.delete(listener);
      },
    };
  }

  disposeAll(): void {
    this.subscriptions.clear();
    this.stopPolling();
    // Release before notifying: a synchronous listener may re-subscribe, and
    // that fresh subscription must register with the active lifecycle. The
    // disposable's dispose is idempotent and never re-enters disposeAll.
    this.clearShutdownRegistration();
    this.notifyKeysChanged();
  }

  /**
   * Subclass entry point. Looks up `key` in the map, creates initial state via
   * `initState()` if absent (enforcing the max-concurrent cap), adds the
   * listener, and returns the Disposable that removes only this listener.
   *
   * The returned Effect is run by the caller's boundary (the subscription
   * tool's `execute()`): the map mutation happens in the run's synchronous
   * prelude, and starting the poll loop is forking a daemon fiber of the
   * runtime that runs it — so this module holds no `Effect.run*` call of its
   * own (R1). The max-concurrent throw stays a defect: it reaches the tool as
   * the same plain `Error` it always was.
   */
  protected register(
    key: K,
    initState: () => S,
    onEvent: PollEventListener,
  ): Effect.Effect<Disposable> {
    return Effect.suspend(() => {
      let state = this.subscriptions.get(key);
      let created = false;
      if (!state) {
        if (this.subscriptions.size >= this.config.maxConcurrent) {
          throw new Error(
            `Too many active ${this.config.name} subscriptions (max ${this.config.maxConcurrent}). Unsubscribe from one before adding another.`,
          );
        }
        state = initState();
        this.subscriptions.set(key, state);
        this.logger.info(`Subscribed to ${key}`);
        created = true;
      }
      state.listeners.add(onEvent);
      if (created) this.notifyKeysChanged();
      const disposable: Disposable = {
        dispose: () => this.removeListener(key, onEvent),
      };
      return this.ensurePolling().pipe(Effect.as(disposable));
    });
  }

  /** Emit a text message to every listener attached to a subscription. */
  protected emit(state: S, text: string): Effect.Effect<void> {
    return Effect.forEach(
      state.listeners,
      (listener) => this.emitToListener(listener, text),
      { discard: true },
    );
  }

  /**
   * Deliver one message to one listener. The single guarded delivery point:
   * subclasses that build per-listener text (e.g. annotation filtering) route
   * through here instead of calling the listener directly.
   *
   * The listener is invoked on the emit turn — its capture (which binding,
   * which owner) happens before any later detach can re-key the maps — and
   * its delivery program is forked as a daemon, so a slow or hanging delivery
   * never stalls the poll round. A synchronous throw while building the
   * program is the defect the old try/catch logged as 'Listener threw'.
   */
  protected emitToListener(
    listener: PollEventListener,
    text: string,
  ): Effect.Effect<void> {
    return Effect.suspend(() => Effect.forkDetach(listener(text))).pipe(
      Effect.asVoid,
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          this.logger.warn('Listener threw', { data: defect });
        }),
      ),
    );
  }

  /**
   * Validate a 200-path payload without ever throwing. The policy behind every
   * poller's use of this helper: a throw on the 200 path is a defect — pollOne
   * runs inside pollEntry, whose catchDefect routes a throw to handleFailure
   * and bumps consecutiveFailures every tick without advancing lastSuccessAt,
   * so a persistently-odd-but-200 payload would trip the 24 h detach gate and
   * unilaterally detach a live subscription. Validation is therefore always
   * safeParse + warn + skip: returning normally lets pollEntry reset
   * lastSuccessAt/consecutiveFailures, and the caller's per-site skip
   * semantics decide what part of the tick is skipped. A 304 passes through
   * untouched.
   */
  protected validateOrSkip<T>(
    res: SuccessfulConditionalResponse<unknown>,
    schema: ZodType<T>,
    label: string,
  ): SuccessfulConditionalResponse<T> | undefined;
  protected validateOrSkip<T>(
    res: ConditionalResponse<unknown>,
    schema: ZodType<T>,
    label: string,
  ): ConditionalResponse<T> | undefined;
  protected validateOrSkip<T>(
    res: ConditionalResponse<unknown>,
    schema: ZodType<T>,
    label: string,
  ): ConditionalResponse<T> | undefined {
    if (res.status === 304) return res;
    const parsed = schema.safeParse(res.data);
    if (!parsed.success) {
      this.logger.warn(label, { data: parsed.error });
      return undefined;
    }
    return { ...res, data: parsed.data };
  }

  /**
   * Consume one comment-shaped conditional GET in the shared comment-list
   * pipeline. Every poller repeats the same choreography for a comment
   * resource: on a 200, commit the ETag; seed the dedup resource on the first
   * tick (so pre-subscription history is never replayed); and on later ticks
   * diff + emit with the bot filter applied.
   *
   * Malformed-payload policy stays at the call site — validate via
   * `validateOrSkip` before calling (skip-whole-tick) or up front for the whole
   * tick, or not at all — and `emitEvent` owns the per-resource emit shape
   * (formatting plus any URL gate). The seed-or-diff choice reads
   * `isInitialized()` so callers that interleave phases (Issue) and callers
   * that split them behind an early-return first-tick block (PR/Repo) both
   * work. Never fails: the whole batch is classified against the dedup window
   * before the first delivery forks, exactly as the sync diff-then-emit did.
   */
  protected consumeCommentList<T extends { user: GhUser | null | undefined }>(
    res: ConditionalResponse<readonly T[]>,
    etagSlot: (etag: string | undefined) => void,
    deduped: DedupedResource<T>,
    emitEvent: (item: T) => Effect.Effect<void>,
    isInitialized: () => boolean,
  ): Effect.Effect<void> {
    if (res.status !== 200) return Effect.void;
    return Effect.suspend(() => {
      etagSlot(res.etag);
      if (!isInitialized()) {
        deduped.seed(res.data);
        return Effect.void;
      }
      const fresh: T[] = [];
      deduped.diff(res.data, (item) => {
        if (shouldDropBotEvent(item.user)) return;
        fresh.push(item);
      });
      return Effect.forEach(fresh, emitEvent, { discard: true });
    });
  }

  /**
   * Detach a subscription unilaterally (e.g. on PR close, auth failure). No-op
   * if the key is already gone. Always notifies; safe to call from inside
   * `pollOne`.
   */
  protected detach(key: K): void {
    if (!this.subscriptions.delete(key)) return;
    this.notifyKeysChanged();
  }

  /** Emit a formatted halted-subscription error, then detach the key. The
   *  listeners capture their delivery before the detach re-keys anything. */
  private emitErrorAndDetach(
    key: K,
    state: S,
    detail: string,
  ): Effect.Effect<void> {
    return this.emit(state, this.formatErrorEvent(state, detail)).pipe(
      Effect.andThen(Effect.sync(() => this.detach(key))),
    );
  }

  private removeListener(key: K, onEvent: PollEventListener): void {
    const state = this.subscriptions.get(key);
    if (!state) return;
    state.listeners.delete(onEvent);
    if (state.listeners.size === 0) {
      this.subscriptions.delete(key);
      this.logger.info(`Unsubscribed from ${key}`);
      this.notifyKeysChanged();
    }
    if (this.subscriptions.size === 0) this.stopPolling();
  }

  private notifyKeysChanged(): void {
    const keys = [...this.subscriptions.keys()];
    for (const listener of this.keysChangedListeners) {
      try {
        listener(keys);
      } catch (err) {
        this.logger.warn('Keys-changed listener threw', { data: err });
      }
    }
  }

  /**
   * Start the poll loop if it is not already running: one detached fiber that
   * runs a round and then repeats on `Schedule.fixed(pollIntervalMs)`.
   * `Effect.repeat` evaluates the round once before the schedule steps, so
   * first-subscribe polls immediately instead of waiting a full interval, and
   * a single sequential fiber makes overlapping rounds impossible — the
   * in-flight guard the `setInterval` cadence needed is gone with it. A round
   * that outruns the interval is followed immediately by the next one, as the
   * interval's skip-then-fire behaviour did.
   *
   * The fiber is forked detached (into the global scope) by the returned
   * Effect, so it roots at the runtime that runs the subscribe path — the
   * tool boundary's process runtime in production (R1). It lives until
   * `stopPolling` completes its stop Deferred (last unsubscribe,
   * `disposeAll`) or the runtime itself shuts down.
   *
   * The loop sleeps on {@link unrefSleepClock}: a polling timer must never
   * keep a host process alive on its own. Its readings are the ambient
   * clock's, so `Clock.currentTimeMillis` inside a round is unaffected.
   */
  private ensurePolling(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.registerShutdownIfNeeded();
      if (this.pollLoopStop) return Effect.void;
      const stop = Deferred.makeUnsafe<void>();
      this.pollLoopStop = stop;
      return Effect.forkDetach(
        Effect.raceFirst(this.pollLoopProgram(), Deferred.await(stop)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              // A stopped loop may finish after a new subscription has started.
              if (this.pollLoopStop === stop) this.pollLoopStop = undefined;
            }),
          ),
        ),
      ).pipe(Effect.asVoid);
    });
  }

  private readonly pollLoopProgram = Effect.fn('PollingSourceBase.pollLoop')(
    function* (this: PollingSourceBase<K, S>) {
      const clock = yield* Clock.Clock;
      yield* Effect.repeat(this.runRound(), {
        schedule: Schedule.fixed(Duration.millis(this.config.pollIntervalMs)),
        while: () => {
          if (this.subscriptions.size > 0) return true;
          // Retire before yielding so a new subscription starts a fresh loop.
          this.stopPolling();
          return false;
        },
      }).pipe(Effect.provideService(Clock.Clock, unrefSleepClock(clock)));
    },
  );

  private stopPolling(): void {
    const stop = this.pollLoopStop;
    if (!stop) return;
    this.pollLoopStop = undefined;
    Deferred.doneUnsafe(stop, Effect.void);
  }

  /**
   * One round, with its failures contained so the poller survives them. A
   * round only ever fails by a defect — a throwing `handleFailure` or
   * listener — which used to reject `tick()`'s promise with nobody watching;
   * it is logged here and the loop continues. An interrupt (shutdown, the
   * last unsubscribe) is re-raised so the fiber ends.
   */
  private readonly runRound = Effect.fn('PollingSourceBase.runRound')(
    function* (this: PollingSourceBase<K, S>) {
      const exit = yield* Effect.exit(this.pollRound());
      if (Exit.isSuccess(exit)) return;
      if (Cause.hasInterrupts(exit.cause)) {
        return yield* Effect.failCause(exit.cause);
      }
      this.logger.warn('Poll round failed; polling continues.', {
        data: Cause.squash(exit.cause),
      });
    },
  );

  /**
   * Register `disposeAll` with the platform shutdown registry exactly once per
   * lifecycle instance. Runs on the first subscription, which only happens
   * after `initPlatform()` in every host — the shared singletons constructed
   * at module load do nothing until then, so `platform()` throwing here means
   * a genuine initialization-order defect, not an expected state.
   *
   * Re-checked on every subscribe, so a lifecycle replacement (extension
   * reactivation or test-harness reinstall) is picked up on the next
   * subscription. A live poller whose lifecycle is replaced without a
   * subsequent subscribe is intentionally not self-healed: no production host
   * installs a new lifecycle while the previous one is still live.
   */
  private registerShutdownIfNeeded(): void {
    const lifecycle = platform().lifecycle;
    if (this.shutdownLifecycle === lifecycle) return;
    this.clearShutdownRegistration();
    this.shutdownRegistration = lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
      this.disposeAll(),
    );
    this.shutdownLifecycle = lifecycle;
  }

  private clearShutdownRegistration(): void {
    this.shutdownRegistration?.dispose();
    this.shutdownRegistration = undefined;
    this.shutdownLifecycle = undefined;
  }

  /**
   * Poll every subscription with at most `maxConcurrent` in flight, then run
   * the post-poll hook. Each hook failure is classified or logged at its own
   * site, so no expected failure short-circuits the round. A defect in one
   * entry (a throwing `handleFailure`) does not either: every started poll is
   * joined through its Exit before the combined cause is re-raised, so the
   * round cannot end while a `pollOne` is still running.
   */
  private readonly pollRound = Effect.fn('PollingSourceBase.pollRound')(
    function* (this: PollingSourceBase<K, S>) {
      const now = yield* Clock.currentTimeMillis;
      const entries = [...this.subscriptions.entries()];
      const exits = yield* Effect.forEach(
        entries,
        ([key, state]) => Effect.exit(this.pollEntry(key, state, now)),
        { concurrency: this.config.maxConcurrent },
      );
      const failures = exits.filter(Exit.isFailure);
      if (failures.length > 0) {
        yield* Effect.failCause(
          failures
            .map((exit) => exit.cause)
            .reduce((left, right) => Cause.combine(left, right)),
        );
      }
      yield* this.afterTick(entries, now).pipe(
        Effect.catchTag('PollHookRejected', (rejection) =>
          Effect.sync(() => {
            this.logger.warn('Post-poll hook failed', {
              data: rejection.cause,
            });
          }),
        ),
      );
    },
  );

  /**
   * Poll one subscription, routing every failure of that subscription through
   * handleFailure and never past this entry.
   *
   * A defect is contained here, not propagated. When `pollOne` was a Promise
   * its synchronous throws were caught by `Effect.tryPromise` and classified
   * per subscription; now that it is an Effect they would be defects, and
   * `pollRound` re-raises a failed entry before `afterTick`, so one
   * subclass's bug would skip annotation draining for every subscription in
   * the round and leave the offending one with no backoff and no path to the
   * 24 h detach gate. Interruption is not caught (`catchDefect`, not
   * `catchCause`), so stopping the loop still stops it, and the defect is
   * logged rather than silently folded into the backoff.
   */
  private readonly pollEntry = Effect.fn('PollingSourceBase.pollEntry')(
    function* (this: PollingSourceBase<K, S>, key: K, state: S, now: number) {
      if (state.skipPollUntilMs > now) return;
      yield* this.pollOne(key, state).pipe(
        Effect.flatMap(() =>
          Effect.map(Clock.currentTimeMillis, (completedAt) => {
            state.lastSuccessAt = completedAt;
            state.consecutiveFailures = 0;
          }),
        ),
        Effect.catchTag('PollHookRejected', (rejection) =>
          Effect.flatMap(Clock.currentTimeMillis, (failedAt) =>
            this.handleFailure(key, state, rejection.cause, failedAt),
          ),
        ),
        Effect.catchDefect((defect) =>
          Effect.flatMap(Clock.currentTimeMillis, (failedAt) =>
            Effect.suspend(() => {
              this.logger.warn('Poll threw a defect', { data: defect });
              return this.handleFailure(key, state, defect, failedAt);
            }),
          ),
        ),
      );
    },
  );

  /**
   * Classify one poll failure at `now`, the reading the round took from the
   * clock. The caller supplies it so this stays a pure function of the state
   * and that reading — the rate-limit branch compares it against GitHub's own
   * epoch (`resetAt`), which only a wall-clock reading can be measured
   * against. Emits (the auth and permanent branches) run as Effects so the
   * listener captures land before the detach.
   */
  protected readonly handleFailure = Effect.fn(
    'PollingSourceBase.handleFailure',
  )(function* (
    this: PollingSourceBase<K, S>,
    key: K,
    state: S,
    err: unknown,
    now: number,
  ) {
    if (err instanceof GitHubAuthError) {
      this.logger.warn(`Auth error for ${key}; stopping subscription.`, {
        data: err,
      });
      yield* this.emit(state, this.formatErrorEvent(state, err.message));
      appSignals.emit('githubTokenInvalid', { message: err.message });
      this.detach(key);
      return;
    }
    if (err instanceof GitHubPermanentError) {
      this.logger.warn(`Permanent error for ${key}; stopping subscription.`, {
        data: err,
      });
      yield* this.emitErrorAndDetach(key, state, err.message);
      return;
    }
    if (err instanceof GitHubRateLimitError) {
      // Rate-limit waits don't update lastSuccessAt, so they neither reset
      // the 24 h detach window nor count toward backoff.
      state.skipPollUntilMs = err.resetAt * 1000;
      // A subscription that's been continuously rate-limited (or any mix of
      // failures) past the 24 h window should still age out — without this
      // check the rate-limit branch would hold a slot indefinitely.
      if (now - state.lastSuccessAt >= this.config.maxFailureDurationMs) {
        this.logger.warn(
          `Rate limited polling ${key} and unreachable for over 24 h; detaching.`,
        );
        yield* this.emitErrorAndDetach(
          key,
          state,
          'unreachable for over 24 h; detaching',
        );
        return;
      }
      this.logger.warn(
        `Rate limited polling ${key}; backing off until ${new Date(state.skipPollUntilMs).toISOString()}.`,
      );
      return;
    }
    state.consecutiveFailures += 1;
    // Jittered +/-20% so a network outage doesn't stampede every subscription
    // back at exactly the same moment.
    const actualDelayMs = jitteredExponentialBackoffMs(
      this.config.backoffBaseMs,
      state.consecutiveFailures,
      this.config.backoffMaxMs,
    );
    state.skipPollUntilMs = now + actualDelayMs;
    if (now - state.lastSuccessAt >= this.config.maxFailureDurationMs) {
      this.logger.warn(
        `Poll failed for ${key}; unreachable for over 24 h, detaching.`,
        { data: { failureCount: state.consecutiveFailures, error: err } },
      );
      yield* this.emitErrorAndDetach(
        key,
        state,
        'unreachable for over 24 h; detaching',
      );
      return;
    }
    this.logger.warn(`Poll failed for ${key}; retrying.`, {
      data: {
        failureCount: state.consecutiveFailures,
        retryInSec: Math.round(actualDelayMs / 1000),
        error: err,
      },
    });
  });
}
