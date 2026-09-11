/**
 * Registry that ties polling-source subscriptions to agent run lifecycles.
 * Used identically for per-PR, per-repo, and per-issue subscriptions; only
 * the polling source and key derivation differ.
 *
 * Each (runId, key) pair holds one disposable from the polling source.
 * Event callbacks submit a `live_notification` follow-up so events land in
 * the same follow-up queue user-typed messages use; the agent consumes them
 * via the normal `waitForFollowUp` mechanism. When a run's queue is released
 * (orchestrator disposed, user deleted the run) subscriptions owned by
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
import type { Secrets } from '@platform/secrets';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';

import type { PollEventListener } from './PollingSourceBase';

export interface SubscriptionBinding<K extends string> {
  key: K;
  runIds: readonly RunId[];
}

interface PollingSourceLike<K extends string, Input> {
  subscribe(
    input: Input,
    onEvent: PollEventListener,
  ): Effect.Effect<Disposable, never, Secrets>;
  updateSubscription?(input: Input, onEvent: PollEventListener): void;
  activeKeys(): readonly K[];
  onKeysChanged(listener: (keys: readonly K[]) => void): Disposable;
}

export interface RunSubscriptionRegistryOptions<K extends string, Input> {
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

export class RunSubscriptionRegistry<K extends string, Input> {
  private readonly logger: Pick<AgentTrace, 'info' | 'warn'>;
  private readonly perRun = new Map<RunId, Map<K, BoundSubscription>>();
  private readonly releaseHooks = new Map<SessionHandle, () => void>();
  /**
   * Live binding count per session, kept in lockstep with every place a
   * `BoundSubscription.owner` is set or cleared (new binding, rebind-reassign,
   * unbind, unbindAll, source-key prune, session release). Lets
   * {@link detachReleaseHookIfUnused} answer "does this session still own
   * anything" in O(1) instead of scanning every run's every binding.
   */
  private readonly bindingCountBySession = new Map<SessionHandle, number>();

  constructor(private readonly opts: RunSubscriptionRegistryOptions<K, Input>) {
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
  bind(runId: RunId, input: Input): Effect.Effect<boolean, never, Secrets> {
    return Effect.suspend(() => {
      const key = this.opts.keyOf(input);
      // Capture the session HERE: the returned Effect runs inside the run's
      // AsyncLocalStorage (the github tool's execute()), but onEvent fires
      // later from the detached poll loop where the ALS is empty.
      const session = currentSession();
      const bound = this.perRun.get(runId) ?? new Map<K, BoundSubscription>();
      const existing = bound.get(key);
      if (existing) {
        this.ensureReleaseHook(session);
        const previousOwner = existing.owner;
        existing.owner = session;
        if (previousOwner !== session) {
          this.decrementSessionRefCount(previousOwner);
          this.incrementSessionRefCount(session);
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
              data: { key, runId, err },
            });
          });
        return submitFollowUp(runId, text, {
          session: owner,
          mode: 'live_notification',
        }).pipe(
          Effect.flatMap((result) => {
            if (result.status !== 'sent' && result.status !== 'queued') {
              return Effect.void;
            }
            return Effect.sync(() => {
              owner.publish([
                {
                  type: 'updateQueuedFollowUps',
                  aggregateId: qualifyAggregateId('run', runId),
                  messages: owner.followUps.getAll(runId),
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
          this.perRun.set(runId, bound);
          this.incrementSessionRefCount(session);
          this.ensureReleaseHook(session);
          this.logger.info(`Bound subscription ${key} → run ${runId}`);
          this.emitBindingsChanged();
          return true;
        }),
      );
    });
  }

  /** Returns true if a subscription existed and was removed. */
  unbind(runId: RunId, input: Input): boolean {
    const key = this.opts.keyOf(input);
    const bound = this.perRun.get(runId);
    const binding = bound && this.deleteBoundKey(runId, bound, key);
    if (!bound || !binding) return false;
    this.detachReleaseHookIfUnused(binding.owner);
    binding.disposable.dispose();
    this.emitBindingsChanged();
    return true;
  }

  /**
   * Dispose every binding of `key` across all runs. Returns the number of
   * bindings removed. Lets the settings UI cancel a subscription globally
   * without needing to know which run owns it.
   */
  unbindAll(key: string): number {
    const canonicalKey = key as K;
    const removedBindings: BoundSubscription[] = [];
    const owners = new Set<SessionHandle>();
    for (const [runId, bound] of [...this.perRun]) {
      const binding = this.deleteBoundKey(runId, bound, canonicalKey);
      if (!binding) continue;
      removedBindings.push(binding);
      owners.add(binding.owner);
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
    const runIdsByKey = new Map<K, RunId[]>();
    for (const [runId, bound] of this.perRun) {
      for (const key of bound.keys()) {
        const runIds = runIdsByKey.get(key);
        if (runIds) runIds.push(runId);
        else runIdsByKey.set(key, [runId]);
      }
    }
    return keys.map((key) => ({
      key,
      runIds: runIdsByKey.get(key) ?? [],
    }));
  }

  private ensureReleaseHook(session: SessionHandle): void {
    if (this.releaseHooks.has(session)) return;
    const detach = session.followUps.onRelease((runId) => {
      const bound = this.perRun.get(runId);
      if (!bound) return;
      const owned = [...bound]
        .filter(([, binding]) => binding.owner === session)
        .map(([key]) => key);
      if (owned.length === 0) return;
      const removed = owned
        .map((key) => this.deleteBoundKey(runId, bound, key))
        .filter(
          (binding): binding is BoundSubscription => binding !== undefined,
        );
      this.detachReleaseHookIfUnused(session);
      for (const binding of removed) binding.disposable.dispose();
      this.emitBindingsChanged();
    });
    this.releaseHooks.set(session, detach);
  }

  private detachReleaseHookIfUnused(session: SessionHandle): void {
    if ((this.bindingCountBySession.get(session) ?? 0) > 0) return;
    this.releaseHooks.get(session)?.();
    this.releaseHooks.delete(session);
  }

  private pruneMissingSourceKeys(keys: readonly K[]): void {
    const active = new Set<string>(keys);
    const removedOwners = new Set<SessionHandle>();
    let removed = false;
    for (const [runId, bound] of [...this.perRun]) {
      for (const key of [...bound.keys()]) {
        if (active.has(key)) continue;
        const binding = this.deleteBoundKey(runId, bound, key);
        if (!binding) continue;
        removedOwners.add(binding.owner);
        removed = true;
      }
    }
    for (const owner of removedOwners) this.detachReleaseHookIfUnused(owner);
    if (removed) this.emitBindingsChanged();
  }

  /**
   * Remove one binding, decrementing its owner's ref count and pruning the
   * run's map (and, once empty, `perRun` itself) in the same step. The
   * single place every unbind path shrinks the (runId, key) → binding maps —
   * callers still own disposing the returned binding's `disposable`.
   */
  private deleteBoundKey(
    runId: RunId,
    bound: Map<K, BoundSubscription>,
    key: K,
  ): BoundSubscription | undefined {
    const binding = bound.get(key);
    if (!binding) return undefined;
    bound.delete(key);
    if (bound.size === 0) this.perRun.delete(runId);
    this.decrementSessionRefCount(binding.owner);
    return binding;
  }

  private incrementSessionRefCount(session: SessionHandle): void {
    this.bindingCountBySession.set(
      session,
      (this.bindingCountBySession.get(session) ?? 0) + 1,
    );
  }

  private decrementSessionRefCount(session: SessionHandle): void {
    const count = this.bindingCountBySession.get(session) ?? 0;
    if (count <= 1) this.bindingCountBySession.delete(session);
    else this.bindingCountBySession.set(session, count - 1);
  }

  private emitBindingsChanged(): void {
    appSignals.emit('githubSubscriptionsChanged', undefined);
  }
}
