/**
 * Shared lifecycle, error handling, and timer management for the GitHub
 * polling sources.
 *
 * Subclasses implement only `pollOne()` — the actual endpoints to hit and
 * per-tick state to mutate — plus the error-formatting hook that names the
 * subscription type. Everything around it
 * (subscribe/unsubscribe, change-listener fan-out, the tick loop with
 * `tickInFlight` guard, classification of GitHub errors into auth /
 * permanent / rate-limit / transient, jittered exponential backoff, and the
 * 24 h detach gate) lives here once.
 */

import pMap from 'p-map';

import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { appSignals } from '@eventBus/AppSignals';

import {
  SHUTDOWN_PHASE,
  type Disposable,
  type LifecycleHost,
} from '@platform/interfaces';
import { tryPlatform } from '@platform/platform';
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

export interface BasePollSubscriptionState {
  listeners: Set<(text: string) => void>;
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
  private timer: ReturnType<typeof setInterval> | undefined;
  private shutdownRegistration: Disposable | undefined;
  private shutdownLifecycle: LifecycleHost | undefined;
  private tickInFlight = false;

  constructor(protected readonly config: PollingSourceConfig) {
    this.logger = createChannelTrace(config.name);
  }

  /** Subclass: poll the endpoints for one subscription and emit any new events. */
  protected abstract pollOne(key: K, state: S): Promise<void>;

  /** Optional subclass hook that runs after all subscription polls settle. */
  protected async afterTick(
    _entries: ReadonlyArray<readonly [K, S]>,
    _now: number,
  ): Promise<void> {}

  /** Subclass: format a halted-subscription error event for the listener. */
  protected abstract formatErrorEvent(key: K, state: S, detail: string): string;

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
    this.stopTimer();
    // Release before notifying: a synchronous listener may re-subscribe, and
    // that fresh subscription must register with the active lifecycle. The
    // disposable's dispose is idempotent and never re-enters disposeAll.
    this.clearShutdownRegistration();
    this.notifyKeysChanged();
  }

  /**
   * Subclass entry point. Looks up `key` in the map, creates initial state via
   * `initState()` if absent (enforcing the max-concurrent cap), adds the
   * listener, and returns a Disposable that removes only this listener.
   */
  protected register(
    key: K,
    initState: () => S,
    onEvent: (text: string) => void,
  ): Disposable {
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
    this.ensureTimer();
    return {
      dispose: () => this.removeListener(key, onEvent),
    };
  }

  /** Emit a text message to every listener attached to a subscription. */
  protected emit(state: S, text: string): void {
    for (const cb of state.listeners) {
      this.emitToListener(cb, text);
    }
  }

  /**
   * Deliver one message to one listener. The single guarded delivery point:
   * subclasses that build per-listener text (e.g. annotation filtering) route
   * through here instead of calling the listener directly.
   */
  protected emitToListener(
    listener: (text: string) => void,
    text: string,
  ): void {
    try {
      listener(text);
    } catch (err) {
      this.logger.warn('Listener threw', { data: err });
    }
  }

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
   * work. Never throws.
   */
  protected consumeCommentList<T extends { user: GhUser | null | undefined }>(
    res: ConditionalResponse<readonly T[]>,
    etagSlot: (etag: string | undefined) => void,
    deduped: DedupedResource<T>,
    emitEvent: (item: T) => void,
    isInitialized: () => boolean,
  ): void {
    if (res.status !== 200) return;
    etagSlot(res.etag);
    if (isInitialized()) {
      deduped.diff(res.data, (item) => {
        if (shouldDropBotEvent(item.user)) return;
        emitEvent(item);
      });
    } else {
      deduped.seed(res.data);
    }
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

  /** Emit a formatted halted-subscription error, then detach the key. */
  private emitErrorAndDetach(key: K, state: S, detail: string): void {
    this.emit(state, this.formatErrorEvent(key, state, detail));
    this.detach(key);
  }

  private removeListener(key: K, onEvent: (text: string) => void): void {
    const state = this.subscriptions.get(key);
    if (!state) return;
    state.listeners.delete(onEvent);
    if (state.listeners.size === 0) {
      this.subscriptions.delete(key);
      this.logger.info(`Unsubscribed from ${key}`);
      this.notifyKeysChanged();
    }
    if (this.subscriptions.size === 0) this.stopTimer();
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

  private ensureTimer(): void {
    this.registerShutdownIfNeeded();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
    // A polling timer must never keep a host process alive on its own.
    this.timer.unref?.();
    // Fire an immediate tick so first-subscribe doesn't wait a full interval.
    void this.tick();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Register `disposeAll` with the platform shutdown registry exactly once per
   * lifecycle instance. Uses `tryPlatform()` so the base stays usable in
   * browser/test contexts where no platform is installed, and defers to the
   * first subscription so the shared singletons (constructed at module load,
   * before `initPlatform()`) still register once the platform exists.
   *
   * Re-checked on every subscribe, so a lifecycle replacement (extension
   * reactivation or test-harness reinstall) is picked up on the next
   * subscription. A live poller whose lifecycle is replaced without a
   * subsequent subscribe is intentionally not self-healed: no production host
   * installs a new lifecycle while the previous one is still live.
   */
  private registerShutdownIfNeeded(): void {
    const lifecycle = tryPlatform()?.lifecycle;
    if (!lifecycle || this.shutdownLifecycle === lifecycle) return;
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

  private async tick(): Promise<void> {
    // setInterval fires every pollIntervalMs regardless of prior completion;
    // overlapping ticks would double-emit events. The guard is process-local
    // (one timer per source) so it's race-free.
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const now = Date.now();
      const entries = [...this.subscriptions.entries()];
      await pMap(entries, ([key, state]) => this.pollEntry(key, state, now), {
        concurrency: this.config.maxConcurrent,
        stopOnError: false,
      });
      await this.runAfterTick(entries, now);
      if (this.subscriptions.size === 0) this.stopTimer();
    } finally {
      this.tickInFlight = false;
    }
  }

  /** Poll one subscription, routing any failure through handleFailure. */
  private async pollEntry(key: K, state: S, now: number): Promise<void> {
    if (state.skipPollUntilMs > now) return;
    try {
      await this.pollOne(key, state);
      state.lastSuccessAt = Date.now();
      state.consecutiveFailures = 0;
    } catch (err) {
      this.handleFailure(key, state, err);
    }
  }

  /** Run the post-poll hook, logging but otherwise swallowing its errors. */
  private async runAfterTick(
    entries: ReadonlyArray<readonly [K, S]>,
    now: number,
  ): Promise<void> {
    try {
      await this.afterTick(entries, now);
    } catch (err) {
      this.logger.warn('Post-poll hook failed', { data: err });
    }
  }

  protected handleFailure(key: K, state: S, err: unknown): void {
    const now = Date.now();
    if (err instanceof GitHubAuthError) {
      this.logger.warn(`Auth error for ${key}; stopping subscription.`, {
        data: err,
      });
      this.emit(state, this.formatErrorEvent(key, state, err.message));
      appSignals.emit('githubTokenInvalid', { message: err.message });
      this.detach(key);
      return;
    }
    if (err instanceof GitHubPermanentError) {
      this.logger.warn(`Permanent error for ${key}; stopping subscription.`, {
        data: err,
      });
      this.emitErrorAndDetach(key, state, err.message);
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
        this.emitErrorAndDetach(
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
      this.emitErrorAndDetach(
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
  }
}
