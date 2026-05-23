/**
 * Registry that ties polling-source subscriptions to agent stream lifecycles.
 * Used identically for per-PR, per-repo, and per-issue subscriptions; only
 * the polling source, key derivation, and external event names differ.
 *
 * Each (streamId, key) pair holds one disposable from the polling source.
 * Event callbacks route through `sendFollowUp` so events land in the same
 * follow-up queue user-typed messages use; the agent consumes them via
 * the normal `waitForFollowUp` mechanism. When a stream's queue is released
 * (orchestrator disposed, user deleted the stream) every subscription
 * bound to that stream is auto-disposed.
 */

import type { AgentTrace } from '@agent/trace';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createChannelTrace } from '@logger';
import type { StreamTabId } from '@shared/schemas';

import { emitGitHubSubscriptionChangedToHosts } from './subscriptionEventEmitter';

import type { Disposable } from '@platform/interfaces/disposable';

export interface SubscriptionBinding<K extends string> {
  key: K;
  streamIds: readonly StreamTabId[];
}

interface PollingSourceLike<K extends string, Input> {
  has(key: K): boolean;
  subscribe(
    input: Input,
    onEvent: (text: string) => void,
    runtimeHost: AgentRuntimeHost,
  ): Disposable;
  updateSubscription?(
    input: Input,
    onEvent: (text: string) => void,
    runtimeHost: AgentRuntimeHost,
  ): void;
  activeKeys(): readonly K[];
  onKeysChanged(listener: (keys: readonly K[]) => void): Disposable;
}

export interface StreamSubscriptionRegistryOptions<K extends string, Input> {
  /** Display name for log messages. */
  name: string;
  /** The polling source that owns the subscription. */
  source: PollingSourceLike<K, Input>;
  /** Convert a subscribe-input value to the canonical string key. */
  keyOf: (input: Input) => K;
  /** External event listeners use to refresh ownership display. */
  bindingsChangedEvent:
    | 'prSubscriptionBindingsChanged'
    | 'repoSubscriptionBindingsChanged'
    | 'issueSubscriptionBindingsChanged';
}

interface BoundSubscription {
  disposable: Disposable;
  onEvent: (text: string) => void;
  runtimeHost: AgentRuntimeHost;
}

export class StreamSubscriptionRegistry<K extends string, Input> {
  private readonly logger: AgentTrace;
  private readonly perStream = new Map<
    StreamTabId,
    Map<K, BoundSubscription>
  >();
  private hooksRegistered = false;

  constructor(
    private readonly opts: StreamSubscriptionRegistryOptions<K, Input>,
  ) {
    this.logger = createChannelTrace(opts.name);
  }

  /** Returns true if a new subscription was created, false if it already existed. */
  bind(
    streamId: StreamTabId,
    input: Input,
    runtimeHost: AgentRuntimeHost,
  ): boolean {
    this.ensureHooks();
    const key = this.opts.keyOf(input);
    let bound = this.perStream.get(streamId);
    if (!bound) {
      bound = new Map();
      this.perStream.set(streamId, bound);
    }
    const existing = bound.get(key);
    if (existing) {
      existing.runtimeHost = runtimeHost;
      this.opts.source.updateSubscription?.(
        input,
        existing.onEvent,
        runtimeHost,
      );
      return false;
    }
    // Set a sentinel before subscribe() so list() returns correct owner
    // data if the source's keys-changed hook fires synchronously inside
    // subscribe() before the real disposable is available.
    const subscription: BoundSubscription = {
      disposable: { dispose: () => {} },
      onEvent: () => {},
      runtimeHost,
    };
    subscription.onEvent = (text: string) => {
      void sendFollowUp(streamId, text).then((result) => {
        if (result.status === 'sent' || result.status === 'queued') {
          subscription.runtimeHost.emit('updateQueuedFollowUps', { streamId });
        }
      });
    };
    bound.set(key, subscription);
    // The source's keys-changed event fires synchronously during subscribe()
    // for new keys (covering the UI refresh); only emit our registry event
    // for existing keys where that source event won't fire.
    const keyIsNew = !this.opts.source.has(key);
    let disposable: Disposable;
    try {
      disposable = this.opts.source.subscribe(
        input,
        subscription.onEvent,
        runtimeHost,
      );
    } catch (err) {
      this.removeBoundKey(streamId, bound, key);
      throw err;
    }
    subscription.disposable = disposable;
    this.logger.info(`Bound subscription ${key} → stream ${streamId}`);
    if (!keyIsNew) this.emitBindingsChanged([runtimeHost]);
    return true;
  }

  /** Returns true if a subscription existed and was removed. */
  unbind(
    streamId: StreamTabId,
    input: Input,
    runtimeHost: AgentRuntimeHost,
  ): boolean {
    const key = this.opts.keyOf(input);
    const bound = this.perStream.get(streamId);
    const binding = bound?.get(key);
    if (!bound || !binding) return false;
    this.removeBoundKey(streamId, bound, key);
    this.disposeSafe(binding.disposable, 'explicit unsubscribe');
    this.emitBindingsChanged([runtimeHost]);
    return true;
  }

  /**
   * Dispose every binding of `key` across all streams. Returns the number of
   * bindings removed. Lets the settings UI cancel a subscription globally
   * without needing to know which stream owns it.
   */
  unbindAll(key: string, runtimeHost: AgentRuntimeHost): number {
    const removedBindings: BoundSubscription[] = [];
    const runtimeHosts: AgentRuntimeHost[] = [];
    for (const [streamId, bound] of [...this.perStream]) {
      const binding = bound.get(key as K);
      if (!binding) continue;
      removedBindings.push(binding);
      runtimeHosts.push(binding.runtimeHost);
      this.removeBoundKey(streamId, bound, key as K);
    }
    if (removedBindings.length > 0) {
      for (const binding of removedBindings) {
        this.disposeSafe(binding.disposable, 'unbindAll');
      }
      runtimeHosts.push(runtimeHost);
      this.emitBindingsChanged(runtimeHosts);
    }
    return removedBindings.length;
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
      const runtimeHosts = [...bound.values()].map(
        (binding) => binding.runtimeHost,
      );
      this.perStream.delete(streamId);
      for (const binding of bound.values()) {
        this.disposeSafe(binding.disposable, 'release');
      }
      this.emitBindingsChanged(runtimeHosts);
    });
    // The polling source can detach subscriptions unilaterally (PR closed,
    // auth failure, 24 h unreachable). Listen to the source directly; the
    // progress event is for UI refresh, not for internal bookkeeping.
    this.opts.source.onKeysChanged((keys) => {
      this.pruneMissingSourceKeys(keys);
    });
    this.hooksRegistered = true;
  }

  private pruneMissingSourceKeys(keys: readonly K[]): void {
    const active = new Set<string>(keys);
    const runtimeHosts: AgentRuntimeHost[] = [];
    for (const [streamId, bound] of [...this.perStream]) {
      for (const key of [...bound.keys()]) {
        if (!active.has(key)) {
          const binding = bound.get(key);
          if (binding) runtimeHosts.push(binding.runtimeHost);
          bound.delete(key);
        }
      }
      if (bound.size === 0) this.perStream.delete(streamId);
    }
    if (runtimeHosts.length > 0) this.emitBindingsChanged(runtimeHosts);
  }

  private removeBoundKey(
    streamId: StreamTabId,
    bound: Map<K, BoundSubscription>,
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

  private emitBindingsChanged(runtimeHosts: Iterable<AgentRuntimeHost>): void {
    emitGitHubSubscriptionChangedToHosts(
      runtimeHosts,
      this.opts.bindingsChangedEvent,
      undefined,
    );
  }
}
