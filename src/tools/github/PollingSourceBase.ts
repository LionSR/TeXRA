/**
 * Shared lifecycle, error handling, and timer management for the GitHub
 * polling sources.
 *
 * Subclasses implement only `pollOne()` — the actual endpoints to hit and
 * per-tick state to mutate — plus the few format / event hooks that name the
 * subscription type. Everything around it
 * (subscribe/unsubscribe, change-listener fan-out, the tick loop with
 * `tickInFlight` guard, classification of GitHub errors into auth /
 * permanent / rate-limit / transient, jittered exponential backoff, and the
 * 24 h detach gate) lives here once.
 */

import pMap from 'p-map';

import type { AgentTrace } from '@agent/trace';
import { appSignals } from '@eventBus/AppSignals';
import { createChannelTrace } from '@logger';

import {
  createBoundedIdSet,
  type BoundedIdSet,
} from '@utils/core/boundedIdSet';

import {
  type ConditionalResponse,
  GitHubAuthError,
  GitHubPermanentError,
  GitHubRateLimitError,
} from './githubClient';
import type { ZodType } from 'zod';

import type { Disposable } from '@platform/interfaces';

export interface BasePollSubscriptionState {
  listeners: Set<(text: string) => void>;
  /** Most recent successful poll. The 24 h detach gate compares against this. */
  lastSuccessAt: number;
  consecutiveFailures: number;
  /** Epoch-ms until which this subscription skips polling (rate-limit or backoff). */
  skipPollUntilMs: number;
}

export interface PollingSourceConfig {
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

export const DEFAULT_POLLING_BACKOFF_CONFIG = {
  backoffBaseMs: 60_000,
  backoffMaxMs: 3_600_000,
  maxFailureDurationMs: 24 * 3_600_000,
} satisfies Pick<
  PollingSourceConfig,
  'backoffBaseMs' | 'backoffMaxMs' | 'maxFailureDurationMs'
>;

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
    for (const item of items) {
      const id = this.getId(item);
      if (this.seenIds.has(id)) continue;
      this.seenIds.add(id);
      emit(item);
    }
    this.advanceCursor(items);
  }

  private advanceCursor(items: readonly T[]): void {
    const newest = this.getCursor?.(items);
    if (newest) this.sinceCursor = newest;
  }
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

  /** Subclass: publish the externally visible subscription-changed event. */
  protected abstract emitKeysChangedEvent(keys: readonly K[]): void;

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
      try {
        cb(text);
      } catch (err) {
        this.logger.warn('Listener threw', { data: err });
      }
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
    this.emitKeysChangedEvent(keys);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
    // Fire an immediate tick so first-subscribe doesn't wait a full interval.
    void this.tick();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
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
    const backoffMs = Math.min(
      this.config.backoffBaseMs * 2 ** (state.consecutiveFailures - 1),
      this.config.backoffMaxMs,
    );
    // Jitter +/-20% so a network outage doesn't stampede every subscription
    // back at exactly the same moment.
    const jitter = 0.8 + Math.random() * 0.4;
    const actualDelayMs = Math.round(backoffMs * jitter);
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
