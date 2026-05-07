/**
 * Generic binder that ties polling-source subscriptions to agent stream
 * lifecycles. Used identically for per-PR and per-repo flavors — only the
 * polling-source reference, key derivation, and bus-event names differ.
 *
 * Each (streamId, key) pair holds one disposable from the polling source.
 * Event callbacks route through `sendFollowUp` so events land in the same
 * follow-up queue user-typed messages use; the agent consumes them via
 * the normal `waitForFollowUp` mechanism. When a stream's queue is released
 * (orchestrator disposed, user deleted the stream) every subscription
 * bound to that stream is auto-disposed.
 */

import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { getAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import type { StreamTabId } from '@shared/schemas';

import type { Disposable } from './PollingSourceBase';

export interface SubscriptionBinding<K extends string> {
  key: K;
  streamIds: readonly StreamTabId[];
}

interface PollingSourceLike<K extends string, Input> {
  has(key: K): boolean;
  subscribe(input: Input, onEvent: (text: string) => void): Disposable;
  activeKeys(): readonly K[];
}

export interface SubscriptionBinderOptions<K extends string, Input> {
  /** Display name for log messages. */
  name: string;
  /** The polling source that owns the subscription. */
  source: PollingSourceLike<K, Input>;
  /** Convert a subscribe-input value to the canonical string key. */
  keyOf: (input: Input) => K;
  /**
   * The bus event the polling source itself emits when its key set changes.
   * The binder listens to it to prune stale per-stream entries when a
   * subscription is auto-detached (PR closed, auth failed, etc.).
   */
  sourceKeysChangedEvent:
    | 'prSubscriptionsChanged'
    | 'repoSubscriptionsChanged'
    | 'issueSubscriptionsChanged';
  /** The binder-owned bus event the settings UI listens to for owner refresh. */
  bindingsChangedEvent:
    | 'prSubscriptionBindingsChanged'
    | 'repoSubscriptionBindingsChanged'
    | 'issueSubscriptionBindingsChanged';
}

export class SubscriptionBinder<K extends string, Input> {
  private readonly logger: AgentLogger;
  private readonly perStream = new Map<StreamTabId, Map<K, Disposable>>();
  private hooksRegistered = false;

  constructor(private readonly opts: SubscriptionBinderOptions<K, Input>) {
    this.logger = new AgentLogger(opts.name);
  }

  /** Returns true if a new subscription was created, false if it already existed. */
  bind(streamId: StreamTabId, input: Input): boolean {
    this.ensureHooks();
    const key = this.opts.keyOf(input);
    let bound = this.perStream.get(streamId);
    if (!bound) {
      bound = new Map();
      this.perStream.set(streamId, bound);
    }
    if (bound.has(key)) return false;
    // Set a sentinel before subscribe() so listBindings() returns correct
    // owner data if `sourceKeysChangedEvent` fires synchronously inside
    // subscribe() before the real disposable is available.
    const sentinel: Disposable = { dispose: () => {} };
    bound.set(key, sentinel);
    // The source's keys-changed event fires synchronously during subscribe()
    // for new keys (covering the UI refresh); only emit our binder event for
    // existing keys where that source event won't fire.
    const keyIsNew = !this.opts.source.has(key);
    let disposable: Disposable;
    try {
      disposable = this.opts.source.subscribe(input, (text) => {
        void sendFollowUp(streamId, text).then((result) => {
          if (result.status === 'sent' || result.status === 'queued') {
            getAgentRuntimeHost().emit('updateQueuedFollowUps', { streamId });
          }
        });
      });
    } catch (err) {
      this.removeBoundKey(streamId, bound, key);
      throw err;
    }
    bound.set(key, disposable);
    this.logger.info(`Bound subscription ${key} → stream ${streamId}`);
    if (!keyIsNew) this.emitBindingsChanged();
    return true;
  }

  /** Returns true if a subscription existed and was removed. */
  unbind(streamId: StreamTabId, input: Input): boolean {
    const key = this.opts.keyOf(input);
    const bound = this.perStream.get(streamId);
    const d = bound?.get(key);
    if (!bound || !d) return false;
    this.disposeSafe(d, 'explicit unsubscribe');
    this.removeBoundKey(streamId, bound, key);
    this.emitBindingsChanged();
    return true;
  }

  /**
   * Dispose every binding of `key` across all streams. Returns the number of
   * bindings removed. Lets the settings UI cancel a subscription globally
   * without needing to know which stream owns it.
   */
  unbindAll(key: string): number {
    let removed = 0;
    for (const [streamId, bound] of [...this.perStream]) {
      const d = bound.get(key as K);
      if (!d) continue;
      this.disposeSafe(d, 'unbindAll');
      this.removeBoundKey(streamId, bound, key as K);
      removed += 1;
    }
    if (removed > 0) this.emitBindingsChanged();
    return removed;
  }

  list(
    keys: readonly K[] = this.opts.source.activeKeys(),
  ): SubscriptionBinding<K>[] {
    const streamIdsByKey = new Map<K, StreamTabId[]>();
    for (const [streamId, bound] of this.perStream) {
      for (const key of bound.keys()) {
        const existing = streamIdsByKey.get(key);
        if (existing) {
          existing.push(streamId);
        } else {
          streamIdsByKey.set(key, [streamId]);
        }
      }
    }
    return keys.map((key) => ({
      key,
      streamIds: streamIdsByKey.get(key) ?? [],
    }));
  }

  private ensureHooks(): void {
    if (this.hooksRegistered) return;
    ToolUseFollowUpQueue.onRelease((streamId) => {
      const bound = this.perStream.get(streamId);
      if (!bound) return;
      for (const d of bound.values()) this.disposeSafe(d, 'release');
      this.perStream.delete(streamId);
      this.emitBindingsChanged();
    });
    // The polling source can detach subscriptions unilaterally (PR closed,
    // auth failure, 24 h unreachable). Without this prune the binder's
    // `perStream` map would keep stale disposables and `bind()` calls
    // would incorrectly short-circuit as "already subscribed".
    bus.on(this.opts.sourceKeysChangedEvent, ({ keys }) => {
      const active = new Set<string>(keys);
      for (const [streamId, bound] of [...this.perStream]) {
        for (const key of [...bound.keys()]) {
          if (!active.has(key)) bound.delete(key);
        }
        if (bound.size === 0) this.perStream.delete(streamId);
      }
    });
    this.hooksRegistered = true;
  }

  private removeBoundKey(
    streamId: StreamTabId,
    bound: Map<K, Disposable>,
    key: K,
  ): void {
    bound.delete(key);
    if (bound.size === 0) this.perStream.delete(streamId);
  }

  private disposeSafe(d: Disposable, context: string): void {
    try {
      d.dispose();
    } catch (err) {
      this.logger.warn(`Disposer threw during ${context}: ${String(err)}`);
    }
  }

  private emitBindingsChanged(): void {
    getAgentRuntimeHost().emit(this.opts.bindingsChangedEvent, undefined);
  }
}
