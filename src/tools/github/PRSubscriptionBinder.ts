/**
 * Binds PR subscriptions to agent stream lifecycles.
 *
 * Each (streamId, prKey) pair holds one disposable from the polling source.
 * Event callbacks route through `sendFollowUp`, so events land in the same
 * follow-up queue that user-typed messages use — the agent consumes them via
 * the normal `waitForFollowUp` mechanism.
 *
 * When a stream's queue is released (orchestrator disposed, user deleted the
 * stream), every subscription bound to that stream is auto-disposed.
 */

import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import type { StreamTabId } from '@shared/schemas';

import { prKeyToString, prPollingSource, type PRKey } from './PRPollingSource';
import type { Disposable } from './AsyncEventSource';

const logger = new AgentLogger('PRSubscriptionBinder');

type PerStream = Map<string, Disposable>;

const perStream = new Map<StreamTabId, PerStream>();
let releaseHookRegistered = false;

export interface PRSubscriptionBinding {
  key: string;
  streamIds: readonly StreamTabId[];
}

function emitBindingsChanged(): void {
  bus.emit('prSubscriptionBindingsChanged', undefined);
}

function removeBoundKey(streamId: StreamTabId, bound: PerStream, key: string): void {
  bound.delete(key);
  if (bound.size === 0) perStream.delete(streamId);
}

export function listPRSubscriptionBindings(
  keys: readonly string[] = prPollingSource.activeKeys(),
): PRSubscriptionBinding[] {
  const streamIdsByKey = new Map<string, StreamTabId[]>();

  for (const [streamId, bound] of perStream) {
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

function ensureReleaseHook(): void {
  if (releaseHookRegistered) return;
  ToolUseFollowUpQueue.onRelease((streamId) => {
    const bound = perStream.get(streamId);
    if (!bound) return;
    for (const d of bound.values()) {
      try {
        d.dispose();
      } catch (err) {
        logger.warn(`Disposer threw during release: ${String(err)}`);
      }
    }
    perStream.delete(streamId);
    emitBindingsChanged();
  });
  // PRPollingSource can delete subscriptions unilaterally (PR closed/merged,
  // auth error, repeated failures). Without this prune the binder's
  // `perStream` map would keep stale disposables and re-subscribe calls
  // would incorrectly short-circuit as "already subscribed".
  bus.on('prSubscriptionsChanged', ({ keys }) => {
    const active = new Set(keys);
    for (const [streamId, bound] of [...perStream]) {
      for (const key of [...bound.keys()]) {
        if (!active.has(key)) bound.delete(key);
      }
      if (bound.size === 0) perStream.delete(streamId);
    }
  });
  releaseHookRegistered = true;
}

/** Returns true if a new subscription was created, false if it already existed. */
export function bindPRSubscription(streamId: StreamTabId, pr: PRKey): boolean {
  ensureReleaseHook();
  const key = prKeyToString(pr);
  let bound = perStream.get(streamId);
  if (!bound) {
    bound = new Map();
    perStream.set(streamId, bound);
  }
  if (bound.has(key)) return false;
  // Set a sentinel before subscribe() so that listPRSubscriptionBindings()
  // returns correct owner data if prSubscriptionsChanged fires synchronously
  // inside subscribe() before the real disposable is available.
  const sentinel: Disposable = { dispose: () => {} };
  bound.set(key, sentinel);
  // prSubscriptionsChanged fires synchronously during subscribe() for new keys
  // (covering the UI refresh); only emit here for existing keys where that
  // event won't fire.
  const keyIsNew = !prPollingSource.activeKeys().includes(key);
  let disposable: Disposable;
  try {
    disposable = prPollingSource.subscribe(key, (text) => {
      void sendFollowUp(streamId, text).then((result) => {
        if (result.status === 'sent' || result.status === 'queued') {
          bus.emit('updateQueuedFollowUps', { streamId });
        }
      });
    });
  } catch (err) {
    removeBoundKey(streamId, bound, key);
    throw err;
  }
  bound.set(key, disposable);
  logger.info(`Bound PR subscription ${key} → stream ${streamId}`);
  if (!keyIsNew) emitBindingsChanged();
  return true;
}

/** Returns true if a subscription existed and was removed. */
export function unbindPRSubscription(
  streamId: StreamTabId,
  pr: PRKey,
): boolean {
  const key = prKeyToString(pr);
  const bound = perStream.get(streamId);
  const d = bound?.get(key);
  if (!bound || !d) return false;
  try {
    d.dispose();
  } catch (err) {
    logger.warn(`Disposer threw on explicit unsubscribe: ${String(err)}`);
  }
  removeBoundKey(streamId, bound, key);
  emitBindingsChanged();
  return true;
}

/**
 * Dispose every binding of `key` across all streams. Used by the settings UI
 * to let the user cancel a subscription globally (e.g. from the Git tab's
 * active-subscriptions list) without needing to know which stream owns it.
 * Returns the number of bindings removed.
 */
export function unbindAllForPR(key: string): number {
  let removed = 0;
  for (const [streamId, bound] of [...perStream]) {
    const d = bound.get(key);
    if (!d) continue;
    try {
      d.dispose();
    } catch (err) {
      logger.warn(`Disposer threw during unbindAllForPR: ${String(err)}`);
    }
    removeBoundKey(streamId, bound, key);
    removed += 1;
  }
  if (removed > 0) emitBindingsChanged();
  return removed;
}
