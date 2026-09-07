/**
 * Registry that ties polling-source subscriptions to agent stream lifecycles.
 * Used identically for per-PR, per-repo, and per-issue subscriptions; only
 * the polling source and key derivation differ.
 *
 * Each (streamId, key) pair holds one disposable from the polling source.
 * Event callbacks submit a `live_notification` follow-up so events land in
 * the same follow-up queue user-typed messages use; the agent consumes them
 * via the normal `waitForFollowUp` mechanism. When a stream's queue is released
 * (orchestrator disposed, user deleted the stream) subscriptions owned by
 * that queue's session are auto-disposed.
 */

import { Effect } from 'effect';

import type { AgentTrace } from '@agent/trace';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';

import { appSignals } from '@eventBus/AppSignals';
import { createLog } from '@logger/logUtils';
import type { Disposable } from '@platform/interfaces';
import {
  aggregateId as qualifyAggregateId,
  type StreamTabId,
} from '@shared/schemas';

import type { PollEventListener } from './PollingSourceBase';

export interface SubscriptionBinding<K extends string> {
  key: K;
  streamIds: readonly StreamTabId[];
}

interface PollingSourceLike<K extends string, Input> {
  subscribe(
    input: Input,
    onEvent: PollEventListener,
  ): Effect.Effect<Disposable>;
  updateSubscription?(input: Input, onEvent: PollEventListener): void;
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
  onEvent: PollEventListener;
  /**
   * Owning session captured at bind() time (inside the run's AsyncLocalStorage).
   * onEvent fires later from a detached polling timer where the ALS is empty, so
   * it must travel with the notification — otherwise submitFollowUp falls back
   * to defaultSession() and the follow-up is misrouted/dropped on a non-default
   * session (for example, the desktop process session).
   */
  owner: SessionHandle;
}

export class StreamSubscriptionRegistry<K extends string, Input> {
  private readonly logger: Pick<AgentTrace, 'info' | 'warn'>;
  private readonly perStream = new Map<
    StreamTabId,
    Map<K, BoundSubscription>
  >();
  private readonly releaseHooks = new Map<SessionHandle, () => void>();

  constructor(
    private readonly opts: StreamSubscriptionRegistryOptions<K, Input>,
  ) {
    this.logger = opts.logger ?? createLog(opts.name);
    // Source-key changes are internal bookkeeping. The registry emits the UI
    // signal only after its binding map has reached the corresponding state.
    opts.source.onKeysChanged((keys) => {
      this.pruneMissingSourceKeys(keys);
    });
  }

  /**
   * Returns true if a new subscription was created, false if it already existed.
   *
   * The returned Effect is run by the tool's `execute()` (R1 boundary). Its
   * synchronous prelude runs inside that call — inside the run's
   * AsyncLocalStorage — so the owning session capture below happens with the
   * run's context exactly as the old synchronous `bind()` did.
   */
  bind(streamId: StreamTabId, input: Input): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const key = this.opts.keyOf(input);
      // Capture the session HERE: the returned Effect runs inside the run's
      // AsyncLocalStorage (the github tool's execute()), but onEvent fires
      // later from the detached poll loop where the ALS is empty.
      const session = currentSession();
      const bound =
        this.perStream.get(streamId) ?? new Map<K, BoundSubscription>();
      const existing = bound.get(key);
      if (existing) {
        this.ensureReleaseHook(session);
        const previousOwner = existing.owner;
        existing.owner = session;
        if (previousOwner !== session) {
          this.detachReleaseHookIfUnused(previousOwner);
        }
        this.opts.source.updateSubscription?.(input, existing.onEvent);
        return Effect.succeed(false);
      }
      const onEvent = (text: string): Effect.Effect<void> => {
        // Invoked synchronously on the emit turn (see PollEventListener):
        // capture the binding and its owner now — bind() reassigns the owner
        // on rebind, and the queued-follow-up refresh belongs to the session
        // that delivered. Only the delivery itself runs detached.
        const subscription = bound.get(key);
        if (!subscription) return Effect.void;
        const owner = subscription.owner;
        const reportDeliveryFailure = (err: unknown) =>
          Effect.sync(() => {
            this.logger.warn('Failed to deliver subscription follow-up', {
              data: { key, streamId, err },
            });
          });
        return Effect.tryPromise({
          try: () =>
            submitFollowUp(streamId, text, {
              session: owner,
              mode: 'live_notification',
            }),
          catch: (err) => err,
        }).pipe(
          Effect.flatMap((result) => {
            if (result.status !== 'sent' && result.status !== 'queued') {
              return Effect.void;
            }
            return Effect.sync(() => {
              owner.publish([
                {
                  type: 'updateQueuedFollowUps',
                  aggregateId: qualifyAggregateId('stream', streamId),
                  messages: owner.followUps.getAll(streamId),
                },
              ]);
            });
          }),
          Effect.catch(reportDeliveryFailure),
          // A defect (e.g. publish throwing) got the same warn through the old
          // promise chain's .catch; keep one message for both channels.
          Effect.catchDefect(reportDeliveryFailure),
        );
      };
      return this.opts.source.subscribe(input, onEvent).pipe(
        Effect.map((disposable) => {
          const subscription: BoundSubscription = {
            disposable,
            onEvent,
            owner: session,
          };
          bound.set(key, subscription);
          this.perStream.set(streamId, bound);
          this.ensureReleaseHook(session);
          this.logger.info(`Bound subscription ${key} → stream ${streamId}`);
          this.emitBindingsChanged();
          return true;
        }),
      );
    });
  }

  /** Returns true if a subscription existed and was removed. */
  unbind(streamId: StreamTabId, input: Input): boolean {
    const key = this.opts.keyOf(input);
    const bound = this.perStream.get(streamId);
    const binding = bound?.get(key);
    if (!bound || !binding) return false;
    this.removeBoundKey(streamId, bound, key);
    this.detachReleaseHookIfUnused(binding.owner);
    binding.disposable.dispose();
    this.emitBindingsChanged();
    return true;
  }

  /**
   * Dispose every binding of `key` across all streams. Returns the number of
   * bindings removed. Lets the settings UI cancel a subscription globally
   * without needing to know which stream owns it.
   */
  unbindAll(key: string): number {
    const canonicalKey = key as K;
    const removedBindings: BoundSubscription[] = [];
    const owners = new Set<SessionHandle>();
    for (const [streamId, bound] of [...this.perStream]) {
      const binding = bound.get(canonicalKey);
      if (!binding) continue;
      removedBindings.push(binding);
      owners.add(binding.owner);
      this.removeBoundKey(streamId, bound, canonicalKey);
    }
    if (removedBindings.length > 0) {
      for (const owner of owners) this.detachReleaseHookIfUnused(owner);
      for (const binding of removedBindings) {
        binding.disposable.dispose();
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
        const streamIds = streamIdsByKey.get(key);
        if (streamIds) streamIds.push(streamId);
        else streamIdsByKey.set(key, [streamId]);
      }
    }
    return keys.map((key) => ({
      key,
      streamIds: streamIdsByKey.get(key) ?? [],
    }));
  }

  private ensureReleaseHook(session: SessionHandle): void {
    if (this.releaseHooks.has(session)) return;
    const detach = session.followUps.onRelease((streamId) => {
      const bound = this.perStream.get(streamId);
      if (!bound) return;
      const owned = [...bound].filter(
        ([, binding]) => binding.owner === session,
      );
      if (owned.length === 0) return;
      for (const [key] of owned) bound.delete(key);
      if (bound.size === 0) this.perStream.delete(streamId);
      this.detachReleaseHookIfUnused(session);
      for (const [, binding] of owned) {
        binding.disposable.dispose();
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

  private emitBindingsChanged(): void {
    appSignals.emit('githubSubscriptionsChanged', undefined);
  }
}
