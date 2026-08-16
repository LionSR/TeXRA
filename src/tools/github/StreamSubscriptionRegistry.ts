/**
 * Registry that ties polling-source subscriptions to agent stream lifecycles.
 * Used identically for per-PR, per-repo, and per-issue subscriptions; only
 * the polling source and key derivation differ.
 *
 * Each (streamId, key) pair holds one disposable from the polling source.
 * Event callbacks route through `deliverLiveNotification` so events land in
 * the same follow-up queue user-typed messages use; the agent consumes them
 * via the normal `waitForFollowUp` mechanism. When a stream's queue is released
 * (orchestrator disposed, user deleted the stream) subscriptions owned by
 * that queue's session are auto-disposed.
 */

import type { AgentTrace } from '@agent/trace';
import { deliverLiveNotification } from '@agent/followUp/liveNotification';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';

import { appSignals } from '@eventBus/AppSignals';
import { createLog } from '@logger/logUtils';
import type { Disposable } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';

export interface SubscriptionBinding<K extends string> {
  key: K;
  streamIds: readonly StreamTabId[];
}

interface PollingSourceLike<K extends string, Input> {
  has(key: K): boolean;
  subscribe(input: Input, onEvent: (text: string) => void): Disposable;
  updateSubscription?(input: Input, onEvent: (text: string) => void): void;
  activeKeys(): readonly K[];
  onKeysChanged(listener: (keys: readonly K[]) => void): Disposable;
}

export interface StreamSubscriptionRegistryOptions<K extends string, Input> {
  /** Display name for log messages. */
  name: string;
  /** Logger override. */
  logger?: Pick<AgentTrace, 'info' | 'warn'>;
  /** The polling source that owns the subscription. */
  source: PollingSourceLike<K, Input>;
  /** Convert a subscribe-input value to the canonical string key. */
  keyOf: (input: Input) => K;
}

interface BoundSubscription {
  disposable: Disposable;
  onEvent: (text: string) => void;
  /**
   * Owning session captured at bind() time (inside the run's AsyncLocalStorage).
   * onEvent fires later from a detached polling timer where the ALS is empty, so
   * it must travel with the notification — otherwise submitFollowUp falls back
   * to defaultSession() and the follow-up is misrouted/dropped on a non-default
   * session (for example, the desktop process session).
   */
  owner: SessionHandle;
  /** Continuation generation in which this detached producer was bound. */
  expectedGenerationId: string | undefined;
}

export class StreamSubscriptionRegistry<K extends string, Input> {
  private readonly logger: Pick<AgentTrace, 'info' | 'warn'>;
  private readonly perStream = new Map<
    StreamTabId,
    Map<K, BoundSubscription>
  >();
  private sourceHooksRegistered = false;
  private readonly releaseHooks = new Map<SessionHandle, () => void>();

  constructor(
    private readonly opts: StreamSubscriptionRegistryOptions<K, Input>,
  ) {
    this.logger = opts.logger ?? createLog(opts.name);
  }

  /** Returns true if a new subscription was created, false if it already existed. */
  bind(streamId: StreamTabId, input: Input): boolean {
    const key = this.opts.keyOf(input);
    // Capture the session HERE: bind() runs inside the run's AsyncLocalStorage
    // (the github tool's execute()), but onEvent fires later from a detached
    // polling timer where the ALS is empty.
    const session = currentSession();
    this.ensureHooks(session);
    let bound = this.perStream.get(streamId);
    if (!bound) {
      bound = new Map();
      this.perStream.set(streamId, bound);
    }
    const existing = bound.get(key);
    if (existing) {
      const previousOwner = existing.owner;
      existing.owner = session;
      existing.expectedGenerationId =
        session.followUps.currentGenerationId(streamId);
      if (previousOwner !== session) {
        this.detachReleaseHookIfUnused(previousOwner);
      }
      this.opts.source.updateSubscription?.(input, existing.onEvent);
      return false;
    }
    // Set a sentinel before subscribe() so list() returns correct owner
    // data if the source's keys-changed hook fires synchronously inside
    // subscribe() before the real disposable is available.
    const subscription: BoundSubscription = {
      disposable: { dispose: () => {} },
      onEvent: () => {},
      owner: session,
      expectedGenerationId: session.followUps.currentGenerationId(streamId),
    };
    subscription.onEvent = (text: string) => {
      deliverLiveNotification({
        streamId,
        followUp: text,
        session: subscription.owner,
        expectedGenerationId: subscription.expectedGenerationId,
        logger: this.logger,
        failure: {
          message: 'Failed to deliver subscription follow-up',
          data: { key, streamId },
        },
      });
    };
    bound.set(key, subscription);
    // The source emits githubSubscriptionsChanged synchronously during
    // subscribe() for new keys (covering the UI refresh); emit here only for
    // existing keys, where that source emission won't fire.
    const keyIsNew = !this.opts.source.has(key);
    let disposable: Disposable;
    try {
      disposable = this.opts.source.subscribe(input, subscription.onEvent);
    } catch (err) {
      this.removeBoundKey(streamId, bound, key);
      this.detachReleaseHookIfUnused(session);
      throw err;
    }
    subscription.disposable = disposable;
    this.logger.info(`Bound subscription ${key} → stream ${streamId}`);
    if (!keyIsNew) this.emitBindingsChanged();
    return true;
  }

  /** Returns true if a subscription existed and was removed. */
  unbind(streamId: StreamTabId, input: Input): boolean {
    const key = this.opts.keyOf(input);
    const bound = this.perStream.get(streamId);
    const binding = bound?.get(key);
    if (!bound || !binding) return false;
    this.removeBoundKey(streamId, bound, key);
    this.detachReleaseHookIfUnused(binding.owner);
    this.disposeSafe(binding.disposable, 'explicit unsubscribe');
    this.emitBindingsChanged();
    return true;
  }

  /**
   * Dispose every binding of `key` across all streams. Returns the number of
   * bindings removed. Lets the settings UI cancel a subscription globally
   * without needing to know which stream owns it.
   */
  unbindAll(key: string): number {
    const removedBindings: BoundSubscription[] = [];
    const owners = new Set<SessionHandle>();
    for (const [streamId, bound] of [...this.perStream]) {
      const binding = bound.get(key as K);
      if (!binding) continue;
      removedBindings.push(binding);
      owners.add(binding.owner);
      this.removeBoundKey(streamId, bound, key as K);
    }
    if (removedBindings.length > 0) {
      for (const owner of owners) this.detachReleaseHookIfUnused(owner);
      for (const binding of removedBindings) {
        this.disposeSafe(binding.disposable, 'unbindAll');
      }
      this.emitBindingsChanged();
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

  private ensureHooks(session: SessionHandle): void {
    if (!this.sourceHooksRegistered) {
      // The polling source can detach subscriptions unilaterally (PR closed,
      // auth failure, 24 h unreachable). Listen to the source directly; the
      // progress event is for UI refresh, not for internal bookkeeping.
      this.opts.source.onKeysChanged((keys) => {
        this.pruneMissingSourceKeys(keys);
      });
      this.sourceHooksRegistered = true;
    }
    this.ensureReleaseHook(session);
  }

  private ensureReleaseHook(session: SessionHandle): void {
    if (this.releaseHooks.has(session)) return;
    const detach = session.followUps.onRelease((streamId) => {
      const bound = this.perStream.get(streamId);
      if (!bound) return;
      const owned = [...bound].filter(([, binding]) => {
        return binding.owner === session;
      });
      if (owned.length === 0) return;
      for (const [key] of owned) bound.delete(key);
      if (bound.size === 0) this.perStream.delete(streamId);
      this.detachReleaseHookIfUnused(session);
      for (const [, binding] of owned) {
        this.disposeSafe(binding.disposable, 'release');
      }
      this.emitBindingsChanged();
    });
    this.releaseHooks.set(session, detach);
  }

  private detachReleaseHookIfUnused(session: SessionHandle): void {
    for (const bound of this.perStream.values()) {
      for (const binding of bound.values()) {
        if (binding.owner === session) return;
      }
    }
    this.releaseHooks.get(session)?.();
    this.releaseHooks.delete(session);
  }

  private pruneMissingSourceKeys(keys: readonly K[]): void {
    const active = new Set<string>(keys);
    const removedOwners = new Set<SessionHandle>();
    let removed = false;
    for (const [streamId, bound] of [...this.perStream]) {
      for (const [key, binding] of [...bound]) {
        if (!active.has(key)) {
          removedOwners.add(binding.owner);
          bound.delete(key);
          removed = true;
        }
      }
      if (bound.size === 0) this.perStream.delete(streamId);
    }
    for (const owner of removedOwners) this.detachReleaseHookIfUnused(owner);
    if (removed) this.emitBindingsChanged();
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
      this.logger.warn(`Disposer threw during ${context}`, { data: err });
    }
  }

  private emitBindingsChanged(): void {
    appSignals.emit('githubSubscriptionsChanged', undefined);
  }
}
