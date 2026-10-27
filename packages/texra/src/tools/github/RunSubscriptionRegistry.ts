/**
 * Registry that ties polling-source subscriptions to agent run lifecycles.
 * Used identically for per-PR, per-repo, and per-issue subscriptions; only
 * the polling source and key derivation differ.
 *
 * Each (runId, key) pair holds one disposable from the polling source.
 * Event callbacks submit a `live_notification` follow-up so events land in
 * the same inbox user-typed messages use; the agent reads them at its next
 * park. When a run takes no more input (it ended for good, its input closed,
 * the user deleted it) or its session's inbox closes, the subscriptions
 * bound through that input are auto-disposed.
 */

import { Effect } from 'effect';

import { withLogChannel } from '@texra-ai/harness';
import { emitAppSignal } from '@eventBus/AppSignals';
import { PrunedNestedMap } from '@texra/utils/core/prunedNestedMap';
import type { Disposable } from '@texra/platform/disposable';
import type { RunInbox } from '@texra-ai/harness/plugins';
import type { RunId } from '@texra-ai/harness/schemas';

import type { GitHubServices } from './githubClient';
import type { PollEventListener } from './PollingSourceBase';

export interface SubscriptionBinding<K extends string> {
  key: K;
  runIds: readonly RunId[];
}

interface PollingSourceLike<K extends string, Input> {
  subscribe(
    input: Input,
    onEvent: PollEventListener,
  ): Effect.Effect<Disposable, never, GitHubServices>;
  updateSubscription?(input: Input, onEvent: PollEventListener): void;
  activeKeys(): readonly K[];
  has(key: K): boolean;
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
   * The run's input handed to bind(). onEvent fires later from a detached
   * polling timer, so the input travels with the binding; a rebind
   * reassigns it to the rebinding call's.
   */
  inbox: RunInbox;
  /** Stops hearing {@link inbox} close. */
  release: () => void;
}

export class RunSubscriptionRegistry<K extends string, Input> {
  private readonly perRun = new PrunedNestedMap<RunId, K, BoundSubscription>();
  private readonly keysListener: Disposable;
  /** The polling source this registry binds runs to. */
  readonly source: PollingSourceLike<K, Input>;

  private readonly opts: RunSubscriptionRegistryOptions<K, Input>;
  constructor(opts: RunSubscriptionRegistryOptions<K, Input>) {
    this.opts = opts;
    this.source = opts.source;
    // Source-key changes are internal bookkeeping. The registry emits the UI
    // signal only after its binding map has reached the corresponding state.
    this.keysListener = opts.source.onKeysChanged((keys) => {
      this.pruneMissingSourceKeys(keys);
    });
  }

  /**
   * Release everything this registry holds on the polling source and the
   * runs' inputs: the source-key listener, and every binding's close
   * listener and subscription. The owning runtime's layer runs it on
   * disposal, before the sources' own lifetime closes.
   */
  dispose(): void {
    this.keysListener.dispose();
    const bindings = [...this.perRun.groups()].flatMap(([, bound]) => [
      ...bound.values(),
    ]);
    this.perRun.clear();
    for (const binding of bindings) release(binding);
    if (bindings.length > 0) this.emitBindingsChanged();
  }

  /**
   * Returns true if a new subscription was created, false if it already existed.
   *
   * `inbox` is the run's input: events deliver their follow-ups to it, and
   * its closing auto-disposes the binding.
   */
  bind(
    runId: RunId,
    input: Input,
    inbox: RunInbox,
  ): Effect.Effect<boolean, never, GitHubServices> {
    return Effect.suspend(() => {
      const key = this.opts.keyOf(input);
      const existing = this.perRun.get(runId, key);
      if (existing) {
        existing.release();
        existing.inbox = inbox;
        existing.release = this.releaseOnClose(runId, key, existing);
        this.opts.source.updateSubscription?.(input, existing.onEvent);
        return Effect.succeed(false);
      }
      const onEvent = (text: string): Effect.Effect<void> => {
        // Invoked synchronously on the emit turn (see PollEventListener):
        // capture the binding and its input now — bind() reassigns the input
        // on rebind, and the delivery belongs to the input the event came
        // through. Only the delivery itself runs in the source-owned FiberSet.
        const subscription = this.perRun.get(runId, key);
        if (!subscription) return Effect.void;
        const { inbox: owner } = subscription;
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
        return owner.send({ text, from }, { hold: 'generation' }).pipe(
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
            inbox,
            release: () => {},
          };
          subscription.release = this.releaseOnClose(runId, key, subscription);
          this.perRun.set(runId, key, subscription);
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
    });
  }

  /** Returns true if a subscription existed and was removed. */
  unbind(runId: RunId, input: Input): boolean {
    const key = this.opts.keyOf(input);
    const binding = this.perRun.delete(runId, key);
    if (!binding) return false;
    release(binding);
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
    for (const [runId] of [...this.perRun.groups()]) {
      const binding = this.perRun.delete(runId, canonicalKey);
      if (binding) removedBindings.push(binding);
    }
    if (removedBindings.length > 0) {
      for (const binding of removedBindings) release(binding);
      this.emitBindingsChanged();
    }
    return removedBindings.length;
  }

  list(
    keys: readonly K[] = this.opts.source.activeKeys(),
  ): SubscriptionBinding<K>[] {
    const bound = Map.groupBy(
      [...this.perRun.groups()].flatMap(([runId, byKey]) =>
        [...byKey.keys()].map((key) => ({ runId, key })),
      ),
      (entry) => entry.key,
    );
    return keys.map((key) => ({
      key,
      runIds: bound.get(key)?.map((entry) => entry.runId) ?? [],
    }));
  }

  /** Dispose the binding of `key` on `runId` once the input it was bound
   *  through closes, unless a later unbind already took it. */
  private releaseOnClose(
    runId: RunId,
    key: K,
    binding: BoundSubscription,
  ): () => void {
    return binding.inbox.onClosed(() => {
      if (this.perRun.get(runId, key) !== binding) return;
      this.perRun.delete(runId, key);
      release(binding);
      this.emitBindingsChanged();
    });
  }

  private pruneMissingSourceKeys(keys: readonly K[]): void {
    const active = new Set<string>(keys);
    let removed = false;
    for (const [runId, bound] of [...this.perRun.groups()]) {
      for (const key of [...bound.keys()]) {
        if (active.has(key)) continue;
        const binding = this.perRun.delete(runId, key);
        if (!binding) continue;
        // The source already dropped the key: only the close listener goes.
        binding.release();
        removed = true;
      }
    }
    if (removed) this.emitBindingsChanged();
  }

  private emitBindingsChanged(): void {
    emitAppSignal('githubSubscriptionsChanged', undefined);
  }
}

/** A removed binding's close listener and subscription, released. */
function release(binding: BoundSubscription): void {
  binding.release();
  binding.disposable.dispose();
}
