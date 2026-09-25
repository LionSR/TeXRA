/**
 * Shared subscription, polling, error and lifetime policy for GitHub sources.
 * A source owns its poll fibers and admitted deliveries until process shutdown;
 * callers run the Effect subscribe path, so this module needs no runner.
 */

import {
  Cause,
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberSet,
  Result,
  Schedule,
  Scope,
} from 'effect';

import { emitAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';

import {
  SHUTDOWN_PHASE,
  type Disposable,
  type LifecycleHost,
  Lifecycle,
} from '@platform/interfaces';
import type { Secrets } from '@platform/secrets';
import { jitteredExponentialBackoffMs } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import { unrefSleepClock } from '@utils/system/unrefSleepClock';
import {
  type ConditionalResponse,
  GitHubAuthError,
  GitHubPermanentError,
  GitHubRateLimitError,
} from './githubClient';
import { shouldDropBotEvent } from './botFilter';
import type { DedupedResource } from './pollingDedup';
import type { GhUser } from './prTypes';
import type { ZodType } from 'zod';

/**
 * Called on the emitting turn to capture the binding and owner before detach.
 * Its returned delivery runs in its owner scope and must recover failures.
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

interface PollingSourceConfig {
  /** Display name used as the log channel and in exception messages. */
  name: string;
  pollIntervalMs: number;
  maxConcurrent: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxFailureDurationMs: number;
}

interface PollingLifetime {
  pollScope: Scope.Closeable;
  deliveryScope: Scope.Closeable;
  deliveries: FiberSet.FiberSet<void>;
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

export { DedupedResource, dedupeComments, MAX_SEEN_IDS } from './pollingDedup';

/**
 * `K` is the canonical string key (PR keys flatten to `owner/repo#N`,
 * repo keys are `owner/repo`); `S` is the per-subscription state object,
 * which must extend `BasePollSubscriptionState`.
 */
export abstract class PollingSourceBase<
  K extends string,
  S extends BasePollSubscriptionState,
> {
  /** Puts an Effect's log entries on this source's channel, `config.name`. */
  protected readonly inLogChannel: ReturnType<typeof withLogChannel>;
  /**
   * What the fiberless listener bookkeeping below (a Disposable's `dispose`,
   * the keys-changed fan-out) has to report, logged in order by the next
   * program this source runs: a register, a poll round, the poll loop's end,
   * or the shutdown hook.
   */
  private readonly notes: Effect.Effect<void>[] = [];
  private readonly subscriptions = new Map<K, S>();
  private readonly keysChangedListeners = new Set<
    (keys: readonly K[]) => void
  >();
  /** The stop request for the owned poll loop; absent while it is stopped. */
  private pollLoopStop: Deferred.Deferred<void> | undefined;
  private lifetime: PollingLifetime | undefined;
  private lifetimeInitializing: Deferred.Deferred<PollingLifetime> | undefined;
  private shutdownRegistration: Disposable | undefined;
  private shutdownLifecycle: LifecycleHost | undefined;

  constructor(protected readonly config: PollingSourceConfig) {
    this.inLogChannel = withLogChannel(config.name);
  }

  /**
   * Subclass: poll the endpoints for one subscription and emit any new
   * events. The base wraps every hook failure in `PollHookRejected` before
   * classifying it, so implementations may fail with the raw endpoint error.
   */
  protected abstract pollOne(
    key: K,
    state: S,
  ): Effect.Effect<void, Error, Secrets>;

  /** Optional subclass hook that runs after all subscription polls settle. */
  protected afterTick(
    _entries: ReadonlyArray<readonly [K, S]>,
    _now: number,
  ): Effect.Effect<void, PollHookRejected, Secrets> {
    return Effect.void;
  }

  /**
   * Warn on this source's channel. A `data` argument, when given, rides the
   * entry raw as its payload; omitting it leaves the entry without one.
   */
  protected logWarning(
    message: string,
    ...data: [] | [unknown]
  ): Effect.Effect<void> {
    const entry = Effect.logWarning(message);
    return (
      data.length === 0 ? entry : Effect.annotateLogs(entry, { data: data[0] })
    ).pipe(this.inLogChannel);
  }

  private logNotes(): Effect.Effect<void> {
    return Effect.suspend(() =>
      Effect.all(this.notes.splice(0), { discard: true }),
    );
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
    this.notifyKeysChanged();
  }

  /**
   * Subclass entry point. Looks up `key` in the map, creates initial state via
   * `initState()` if absent (enforcing the max-concurrent cap), adds the
   * listener, and returns the Disposable that removes only this listener.
   *
   * The caller runs this Effect. Its short critical section commits the
   * binding and starts the source-owned poller together. A capacity refusal
   * remains the same plain Error defect the tool already reports, raised
   * with `Effect.die` rather than a throw inside the suspend.
   */
  protected register(
    key: K,
    initState: () => S,
    onEvent: PollEventListener,
  ): Effect.Effect<Disposable, never, Secrets | Lifecycle> {
    return Effect.uninterruptible(
      Effect.flatMap(Lifecycle, (lifecycle) =>
        Effect.suspend(() => {
          if (lifecycle.shutdownRan) {
            return Effect.die(
              new Error(
                `Cannot subscribe to ${this.config.name} after shutdown`,
              ),
            );
          }
          // A replacement host starts with fresh subscriptions. Stop the old
          // poller now, even if its shutdown is still in the BEFORE phase.
          if (this.shutdownLifecycle?.shutdownRan) this.disposeAll();
          let state = this.subscriptions.get(key);
          const created = !state;
          if (!state) {
            if (this.subscriptions.size >= this.config.maxConcurrent) {
              return Effect.die(
                new Error(
                  `Too many active ${this.config.name} subscriptions (max ${this.config.maxConcurrent}). Unsubscribe from one before adding another.`,
                ),
              );
            }
            state = initState();
            this.subscriptions.set(key, state);
          }
          state.listeners.add(onEvent);
          if (created) this.notifyKeysChanged();
          const disposable: Disposable = {
            dispose: () => this.removeListener(key, onEvent),
          };
          const logSubscribed = created
            ? Effect.logInfo(`Subscribed to ${key}`).pipe(this.inLogChannel)
            : Effect.void;
          return this.logNotes().pipe(
            Effect.andThen(logSubscribed),
            Effect.andThen(this.ensurePolling(lifecycle)),
            Effect.as(disposable),
          );
        }),
      ),
    );
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
   * Capture before detach can re-key the maps; subscribed deliveries belong
   * to the source. Without a lifetime, a direct hook belongs to its caller
   * so it cannot create unowned work. A throwing listener is logged here.
   */
  protected emitToListener(
    listener: PollEventListener,
    text: string,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const delivery = listener(text);
      const deliveries = this.lifetime?.deliveries;
      return deliveries
        ? FiberSet.run(deliveries, delivery)
        : Effect.forkChild(delivery);
    }).pipe(
      Effect.asVoid,
      Effect.catchDefect((defect) => this.logWarning('Listener threw', defect)),
    );
  }

  /**
   * Safe-parse a 200 payload, warning and skipping malformed data. A throw
   * would count as poll failure and eventually detach a reachable source.
   */
  protected validateOrSkip<T>(
    res: SuccessfulConditionalResponse<unknown>,
    schema: ZodType<T>,
    label: string,
  ): Effect.Effect<SuccessfulConditionalResponse<T> | undefined>;
  protected validateOrSkip<T>(
    res: ConditionalResponse<unknown>,
    schema: ZodType<T>,
    label: string,
  ): Effect.Effect<ConditionalResponse<T> | undefined>;
  protected validateOrSkip<T>(
    res: ConditionalResponse<unknown>,
    schema: ZodType<T>,
    label: string,
  ): Effect.Effect<ConditionalResponse<T> | undefined> {
    if (res.status === 304) return Effect.succeed(res);
    const parsed = schema.safeParse(res.data);
    if (!parsed.success) {
      return this.logWarning(label, parsed.error).pipe(Effect.as(undefined));
    }
    return Effect.succeed({ ...res, data: parsed.data });
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
      this.notes.push(
        Effect.logInfo(`Unsubscribed from ${key}`).pipe(this.inLogChannel),
      );
      this.notifyKeysChanged();
    }
    if (this.subscriptions.size === 0) this.stopPolling();
  }

  private notifyKeysChanged(): void {
    const keys = [...this.subscriptions.keys()];
    for (const listener of this.keysChangedListeners) {
      // Listener fan-out is synchronous bookkeeping on the onKeysChanged/
      // Disposable contract, invoked outside any fiber. A throwing listener is
      // logged and the remaining listeners still hear the change: it must not
      // leak into the subscribe path that called it.
      const notified = Result.try({
        try: () => listener(keys),
        catch: ensureError,
      });
      if (Result.isFailure(notified)) {
        this.notes.push(
          this.logWarning('Keys-changed listener threw', notified.failure),
        );
      }
    }
  }

  /**
   * One sequential loop per active source, immediate first round then fixed
   * cadence. The process scope owns it; last unsubscribe signals its stop.
   * {@link unrefSleepClock} keeps an idle timer from holding the process open.
   */
  private ensurePolling(
    lifecycle: LifecycleHost,
  ): Effect.Effect<void, never, Secrets> {
    return Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        const lifetime = yield* this.ensureLifetime(lifecycle);
        if (this.pollLoopStop) return;
        const stop = Deferred.makeUnsafe<void>();
        this.pollLoopStop = stop;
        return yield* Effect.forkIn(
          Effect.raceFirst(this.pollLoopProgram(), Deferred.await(stop)).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                // A stopped loop may finish after a new subscription has started.
                if (this.pollLoopStop === stop) this.pollLoopStop = undefined;
                return this.logNotes();
              }),
            ),
          ),
          lifetime.pollScope,
        ).pipe(Effect.asVoid);
      }),
    );
  }

  /** One owner per lifecycle for poll rounds and admitted deliveries. */
  private ensureLifetime(lifecycle: LifecycleHost) {
    return Effect.suspend(() => {
      // The old owner may still be draining while a replacement host starts.
      // Keep its captured scopes for that drain, but give the new host its own.
      if (this.shutdownLifecycle?.shutdownRan) this.lifetime = undefined;
      if (this.lifetime) {
        this.registerShutdownIfNeeded(lifecycle);
        return Effect.succeed(this.lifetime);
      }
      if (this.lifetimeInitializing) {
        return Deferred.await(this.lifetimeInitializing).pipe(
          Effect.tap(() =>
            Effect.sync(() => this.registerShutdownIfNeeded(lifecycle)),
          ),
        );
      }

      // Claim before scope allocation yields, so concurrent first subscribers
      // share the owner whose shutdown hook will drain their deliveries.
      const pending = Deferred.makeUnsafe<PollingLifetime>();
      this.lifetimeInitializing = pending;
      return Effect.gen({ self: this }, function* () {
        const pollScope = yield* Scope.make();
        const deliveryScope = yield* Scope.make();
        const deliveries = yield* FiberSet.make<void>().pipe(
          Effect.provideService(Scope.Scope, deliveryScope),
        );
        const lifetime = { pollScope, deliveryScope, deliveries };
        this.lifetime = lifetime;
        this.registerShutdownIfNeeded(lifecycle);
        return lifetime;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(pending, exit);
            if (this.lifetimeInitializing === pending) {
              this.lifetimeInitializing = undefined;
            }
          }),
        ),
      );
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
   * One round, with its failures contained so the poller survives them. Single
   * request errors are handled per subscription. Non-interrupted
   * defects and compound failures are logged here once, retaining every reason. An
   * interrupt is re-raised so the fiber ends. This does not recover child
   * failures discarded by the parallel iterator during external interruption.
   */
  private readonly runRound = Effect.fn('PollingSourceBase.runRound')(
    function* (this: PollingSourceBase<K, S>) {
      const exit = yield* Effect.exit(this.pollRound());
      yield* this.logNotes();
      if (Exit.isSuccess(exit)) return;
      if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt;
      yield* this.logWarning(
        'Poll round failed; polling continues.',
        exit.cause.reasons.length === 1 ? Cause.squash(exit.cause) : exit.cause,
      );
    },
  );

  /**
   * One process shutdown hook stops polling before draining already-admitted
   * deliveries. A later subscription may rebind a replacement lifecycle.
   */
  private registerShutdownIfNeeded(lifecycle: LifecycleHost): void {
    if (this.shutdownLifecycle === lifecycle) return;
    // A shutdown already in progress still needs its ON hook to close the old
    // scopes and drain admitted deliveries after a replacement subscribes.
    if (!this.shutdownLifecycle?.shutdownRan) this.clearShutdownRegistration();
    const lifetime = this.lifetime!;
    this.shutdownRegistration = lifecycle.onShutdown(
      SHUTDOWN_PHASE.ON,
      Effect.gen({ self: this }, function* () {
        if (this.lifetime === lifetime) this.disposeAll();
        yield* this.logNotes();
        yield* Scope.close(lifetime.pollScope, Exit.void);
        yield* FiberSet.awaitEmpty(lifetime.deliveries);
      }).pipe(
        Effect.ensuring(Scope.close(lifetime.deliveryScope, Exit.void)),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.lifetime === lifetime) {
              this.lifetime = undefined;
              this.clearShutdownRegistration();
            }
          }),
        ),
      ),
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
        Effect.catchCause((cause) => {
          const reason = cause.reasons[0];
          if (cause.reasons.length !== 1 || reason?._tag !== 'Fail') {
            return Effect.failCause(cause);
          }
          return this.logWarning('Post-poll hook failed', reason.error.cause);
        }),
      );
    },
  );

  /**
   * Poll one subscription, classifying its ordinary single errors here.
   * Interruption and compound failures pass through to the round.
   *
   * A single defect is contained here. When `pollOne` was a Promise
   * its synchronous throws were caught by `Effect.tryPromise` and classified
   * per subscription; now that it is an Effect they would be defects, and
   * `pollRound` re-raises a failed entry before `afterTick`, so one
   * subclass's bug would skip annotation draining for every subscription in
   * the round and leave the offending one with no backoff and no path to the
   * 24 h detach gate. Interruption and compound causes pass through intact;
   * the round reports them without applying several backoff updates to one
   * poll. An ordinary single defect is logged before applying its backoff.
   */
  private readonly pollEntry = Effect.fn('PollingSourceBase.pollEntry')(
    function* (this: PollingSourceBase<K, S>, key: K, state: S, now: number) {
      if (state.skipPollUntilMs > now) return;
      yield* this.pollOne(key, state).pipe(
        Effect.catchCause((cause) =>
          Effect.failCause(
            Cause.map(cause, (error) => new PollHookRejected({ cause: error })),
          ),
        ),
        Effect.flatMap(() =>
          Effect.map(Clock.currentTimeMillis, (completedAt) => {
            state.lastSuccessAt = completedAt;
            state.consecutiveFailures = 0;
          }),
        ),
        Effect.catchCause((cause) => {
          const reason = cause.reasons[0];
          if (cause.reasons.length !== 1 || reason?._tag !== 'Fail') {
            return Effect.failCause(cause);
          }
          return Effect.flatMap(Clock.currentTimeMillis, (failedAt) =>
            this.handleFailure(
              key,
              state,
              (reason.error as PollHookRejected).cause,
              failedAt,
            ),
          );
        }),
        Effect.catchCause((cause) => {
          const reason = cause.reasons[0];
          if (cause.reasons.length !== 1 || reason?._tag !== 'Die') {
            return Effect.failCause(cause);
          }
          return Effect.flatMap(Clock.currentTimeMillis, (failedAt) =>
            this.logWarning('Poll threw a defect', reason.defect).pipe(
              Effect.andThen(
                this.handleFailure(key, state, reason.defect, failedAt),
              ),
            ),
          );
        }),
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
      yield* this.logWarning(
        `Auth error for ${key}; stopping subscription.`,
        err,
      );
      yield* this.emit(state, this.formatErrorEvent(state, err.message));
      emitAppSignal('githubTokenInvalid', { message: err.message });
      this.detach(key);
      return;
    }
    if (err instanceof GitHubPermanentError) {
      yield* this.logWarning(
        `Permanent error for ${key}; stopping subscription.`,
        err,
      );
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
        yield* this.logWarning(
          `Rate limited polling ${key} and unreachable for over 24 h; detaching.`,
        );
        yield* this.emitErrorAndDetach(
          key,
          state,
          'unreachable for over 24 h; detaching',
        );
        return;
      }
      yield* this.logWarning(
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
      yield* this.logWarning(
        `Poll failed for ${key}; unreachable for over 24 h, detaching.`,
        { failureCount: state.consecutiveFailures, error: err },
      );
      yield* this.emitErrorAndDetach(
        key,
        state,
        'unreachable for over 24 h; detaching',
      );
      return;
    }
    yield* this.logWarning(`Poll failed for ${key}; retrying.`, {
      failureCount: state.consecutiveFailures,
      retryInSec: Math.round(actualDelayMs / 1000),
      error: err,
    });
  });
}
