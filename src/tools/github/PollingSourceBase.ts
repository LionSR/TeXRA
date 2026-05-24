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

import type { AgentTrace } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { createChannelTrace } from '@logger';

import {
  GitHubAuthError,
  GitHubPermanentError,
  GitHubRateLimitError,
} from './githubClient';

import type { Disposable } from '@platform/interfaces/disposable';

export interface BasePollSubscriptionState {
  listeners: Set<(text: string) => void>;
  runtimeHostByListener: Map<(text: string) => void, AgentRuntimeHost>;
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
  protected abstract emitKeysChangedEvent(
    keys: readonly K[],
    runtimeHosts: readonly AgentRuntimeHost[],
  ): void;

  activeKeys(): readonly K[] {
    return [...this.subscriptions.keys()];
  }

  protected getSubscriptionState(key: K): S | undefined {
    return this.subscriptions.get(key);
  }

  updateListenerRuntimeHost(
    key: K,
    onEvent: (text: string) => void,
    runtimeHost: AgentRuntimeHost,
  ): void {
    this.subscriptions
      .get(key)
      ?.runtimeHostByListener.set(onEvent, runtimeHost);
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
    const runtimeHosts = this.activeRuntimeHosts();
    this.subscriptions.clear();
    this.stopTimer();
    this.notifyKeysChanged(runtimeHosts);
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
    runtimeHost: AgentRuntimeHost,
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
    state.runtimeHostByListener.set(onEvent, runtimeHost);
    if (created) this.notifyKeysChanged([runtimeHost]);
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
        this.logger.warn(`Listener threw: ${String(err)}`);
      }
    }
  }

  /**
   * Detach a subscription unilaterally (e.g. on PR close, auth failure). No-op
   * if the key is already gone. Always notifies; safe to call from inside
   * `pollOne`.
   */
  protected detach(key: K): void {
    const state = this.subscriptions.get(key);
    if (!state) return;
    const runtimeHosts = this.hostsForState(state);
    this.subscriptions.delete(key);
    this.notifyKeysChanged(runtimeHosts);
  }

  private removeListener(key: K, onEvent: (text: string) => void): void {
    const state = this.subscriptions.get(key);
    if (!state) return;
    const runtimeHost = state.runtimeHostByListener.get(onEvent);
    state.listeners.delete(onEvent);
    state.runtimeHostByListener.delete(onEvent);
    if (state.listeners.size === 0) {
      this.subscriptions.delete(key);
      this.logger.info(`Unsubscribed from ${key}`);
      this.notifyKeysChanged(runtimeHost ? [runtimeHost] : []);
    }
    if (this.subscriptions.size === 0) this.stopTimer();
  }

  private notifyKeysChanged(runtimeHosts = this.activeRuntimeHosts()): void {
    const keys = [...this.subscriptions.keys()];
    for (const listener of this.keysChangedListeners) {
      try {
        listener(keys);
      } catch (err) {
        this.logger.warn(`Keys-changed listener threw: ${String(err)}`);
      }
    }
    this.emitKeysChangedEvent(keys, [...new Set(runtimeHosts)]);
  }

  private activeRuntimeHosts(): AgentRuntimeHost[] {
    const runtimeHosts: AgentRuntimeHost[] = [];
    for (const state of this.subscriptions.values()) {
      runtimeHosts.push(...this.hostsForState(state));
    }
    return [...new Set(runtimeHosts)];
  }

  private hostsForState(state: S): AgentRuntimeHost[] {
    return [...new Set(state.runtimeHostByListener.values())];
  }

  private emitToStateHosts<EventKey extends keyof ProgressEventPayloads>(
    state: S,
    event: EventKey,
    payload: ProgressEventPayloads[EventKey],
  ): void {
    for (const runtimeHost of this.hostsForState(state)) {
      runtimeHost.emit(event, payload);
    }
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
      await Promise.allSettled(
        entries.map(async ([key, state]) => {
          if (state.skipPollUntilMs > now) return;
          try {
            await this.pollOne(key, state);
            state.lastSuccessAt = Date.now();
            state.consecutiveFailures = 0;
          } catch (err) {
            this.handleFailure(key, state, err);
          }
        }),
      );
      try {
        await this.afterTick(entries, now);
      } catch (err) {
        this.logger.warn(`Post-poll hook failed: ${String(err)}`);
      }
      if (this.subscriptions.size === 0) this.stopTimer();
    } finally {
      this.tickInFlight = false;
    }
  }

  protected handleFailure(key: K, state: S, err: unknown): void {
    const now = Date.now();
    if (err instanceof GitHubAuthError) {
      this.logger.warn(
        `Auth error for ${key}; stopping subscription. ${err.message}`,
      );
      this.emit(state, this.formatErrorEvent(key, state, err.message));
      this.emitToStateHosts(state, 'githubTokenInvalid', {
        message: err.message,
      });
      this.detach(key);
      return;
    }
    if (err instanceof GitHubPermanentError) {
      this.logger.warn(
        `Permanent error for ${key} (HTTP ${err.status}); stopping subscription. ${err.message}`,
      );
      this.emit(state, this.formatErrorEvent(key, state, err.message));
      this.detach(key);
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
        this.emit(
          state,
          this.formatErrorEvent(
            key,
            state,
            `unreachable for over 24 h; detaching`,
          ),
        );
        this.detach(key);
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
    // Jitter ±20% so a network outage doesn't stampede every subscription
    // back at exactly the same moment.
    const jitter = 0.8 + Math.random() * 0.4;
    const actualDelayMs = Math.round(backoffMs * jitter);
    state.skipPollUntilMs = now + actualDelayMs;
    if (now - state.lastSuccessAt >= this.config.maxFailureDurationMs) {
      this.logger.warn(
        `Poll failed for ${key} (failure #${state.consecutiveFailures}); ` +
          `unreachable for over 24 h, detaching: ${String(err)}`,
      );
      this.emit(
        state,
        this.formatErrorEvent(
          key,
          state,
          `unreachable for over 24 h; detaching`,
        ),
      );
      this.detach(key);
      return;
    }
    this.logger.warn(
      `Poll failed for ${key} (failure #${state.consecutiveFailures}, ` +
        `retrying in ${Math.round(actualDelayMs / 1000)}s): ${String(err)}`,
    );
  }
}
