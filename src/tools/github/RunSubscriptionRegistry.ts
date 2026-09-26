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

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

import { emitAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';
import {
  AgentResume,
  type Disposable,
  type Lifecycle,
} from '@platform/interfaces';
import type { Secrets } from '@platform/secrets';
import type { RunId } from '@shared/schemas';

import type { PollEventListener } from './PollingSourceBase';

export interface SubscriptionBinding<K extends string> {
  key: K;
  runIds: readonly RunId[];
}

interface PollingSourceLike<K extends string, Input> {
  subscribe(
    input: Input,
    onEvent: PollEventListener,
  ): Effect.Effect<Disposable, never, Secrets | Lifecycle>;
  updateSubscription?(input: Input, onEvent: PollEventListener): void;
  activeKeys(): readonly K[];
  onKeysChanged(listener: (keys: readonly K[]) => void): Disposable;
}

export interface RunSubscriptionRegistryOptions<K extends string, Input> {
  /** Log channel for this registry's messages. */
  name: string;
  /** The polling source that owns the subscription. */
  source: PollingSourceLike<K, Input>;
  /** Convert a subscribe-input value to the canonical string key. */
  keyOf: (input: Input) => K;
}

interface BoundSubscription {
  disposable: Disposable;
  onEvent: PollEventListener;
  /**
   * Owning session handed to bind(). onEvent fires later from a detached
   * polling timer, so the session travels with the binding; a rebind
   * reassigns it to the rebinding session.
   */
  owner: SessionHandle;
}

export class RunSubscriptionRegistry<K extends string, Input> {
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
  private readonly keysListener: Disposable;

  constructor(private readonly opts: RunSubscriptionRegistryOptions<K, Input>) {
    // Source-key changes are internal bookkeeping. The registry emits the UI
    // signal only after its binding map has reached the corresponding state.
    this.keysListener = opts.source.onKeysChanged((keys) => {
      this.pruneMissingSourceKeys(keys);
    });
  }

  /**
   * Release everything this registry holds on the polling source and the
   * sessions: the source-key listener, every session release hook, and every
   * binding's subscription. The owning runtime's layer runs it on disposal,
   * so a replacement runtime inherits no listener on the module-singleton
   * sources (#12933).
   */
  dispose(): void {
    this.keysListener.dispose();
    for (const detach of this.releaseHooks.values()) detach();
    this.releaseHooks.clear();
    this.bindingCountBySession.clear();
    const bindings = [...this.perRun.values()].flatMap((bound) => [
      ...bound.values(),
    ]);
    this.perRun.clear();
    for (const binding of bindings) binding.disposable.dispose();
    if (bindings.length > 0) this.emitBindingsChanged();
  }

  /**
   * Returns true if a new subscription was created, false if it already existed.
   *
   * `session` is the owning session: events deliver their follow-ups to it and
   * its follow-up queue's release auto-disposes the binding.
   */
  bind(
    runId: RunId,
    input: Input,
    session: SessionHandle,
  ): Effect.Effect<boolean, never, Secrets | AgentResume | Lifecycle> {
    // The resume port is captured now: onEvent fires from the source-owned poll
    // loop, whose context has no AgentResume.
    return Effect.flatMap(AgentResume, (agentResume) =>
      Effect.suspend(() => {
        const key = this.opts.keyOf(input);
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
          // on rebind, and the delivery belongs to the session the event came
          // through. Only the delivery itself runs in the source-owned FiberSet.
          const subscription = bound.get(key);
          if (!subscription) return Effect.void;
          const owner = subscription.owner;
          // The identifiers ride in the message: the sink renders `data` with
          // sorted keys under a length bound, so beside an error's stack they
          // would be the part truncated away.
          const reportDeliveryFailure = (err: unknown) =>
            Effect.logWarning(
              `Failed to deliver subscription follow-up for ${key} (run ${runId})`,
            ).pipe(
              Effect.annotateLogs({ data: { err } }),
              withLogChannel(this.opts.name),
            );
          const from = { kind: 'notification', source: 'github' } as const;
          return submitFollowUp(
            runId,
            { text, from },
            {
              session: owner,
              mode: 'live_notification',
            },
          ).pipe(
            Effect.provideService(AgentResume, agentResume),
            Effect.asVoid,
            Effect.catch(reportDeliveryFailure),
            // A defect (e.g. publish throwing) got the same warn through the old
            // promise chain's .catch; keep one message for both channels.
            Effect.catchDefect(reportDeliveryFailure),
          );
        };
        return this.opts.source.subscribe(input, onEvent).pipe(
          Effect.flatMap((disposable) => {
            const subscription: BoundSubscription = {
              disposable,
              onEvent,
              owner: session,
            };
            bound.set(key, subscription);
            this.perRun.set(runId, bound);
            this.incrementSessionRefCount(session);
            this.ensureReleaseHook(session);
            return Effect.logInfo(
              `Bound subscription ${key} → run ${runId}`,
            ).pipe(
              withLogChannel(this.opts.name),
              Effect.andThen(
                Effect.sync(() => {
                  this.emitBindingsChanged();
                  return true;
                }),
              ),
            );
          }),
        );
      }),
    );
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
      const removed = [...bound]
        .filter(([, binding]) => binding.owner === session)
        .flatMap(([key]) => this.deleteBoundKey(runId, bound, key) ?? []);
      if (removed.length === 0) return;
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
    for (const [runId, bound] of [...this.perRun]) {
      for (const key of [...bound.keys()]) {
        if (active.has(key)) continue;
        const binding = this.deleteBoundKey(runId, bound, key);
        if (!binding) continue;
        removedOwners.add(binding.owner);
      }
    }
    for (const owner of removedOwners) this.detachReleaseHookIfUnused(owner);
    if (removedOwners.size > 0) this.emitBindingsChanged();
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
    emitAppSignal('githubSubscriptionsChanged', undefined);
  }
}
