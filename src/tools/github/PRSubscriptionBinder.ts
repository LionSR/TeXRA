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

import {
  prKeyToString,
  prPollingSource,
  type PRKey,
} from './PRPollingSource';
import type { Disposable } from './AsyncEventSource';

const logger = new AgentLogger('PRSubscriptionBinder');

type PerStream = Map<string, Disposable>;

const perStream = new Map<StreamTabId, PerStream>();
let releaseHookRegistered = false;

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
  });
  releaseHookRegistered = true;
}

export function bindPRSubscription(
  streamId: StreamTabId,
  pr: PRKey,
): { alreadySubscribed: boolean } {
  ensureReleaseHook();
  const key = prKeyToString(pr);
  let bound = perStream.get(streamId);
  if (!bound) {
    bound = new Map();
    perStream.set(streamId, bound);
  }
  if (bound.has(key)) {
    return { alreadySubscribed: true };
  }
  const disposable = prPollingSource.subscribe(key, (text) => {
    void sendFollowUp(streamId, text).then((result) => {
      if (result.status === 'sent' || result.status === 'queued') {
        bus.emit('updateQueuedFollowUps', { streamId });
      }
    });
  });
  bound.set(key, disposable);
  logger.info(`Bound PR subscription ${key} → stream ${streamId}`);
  return { alreadySubscribed: false };
}

export function unbindPRSubscription(
  streamId: StreamTabId,
  pr: PRKey,
): { wasSubscribed: boolean } {
  const key = prKeyToString(pr);
  const bound = perStream.get(streamId);
  const d = bound?.get(key);
  if (!bound || !d) return { wasSubscribed: false };
  try {
    d.dispose();
  } catch (err) {
    logger.warn(`Disposer threw on explicit unsubscribe: ${String(err)}`);
  }
  bound.delete(key);
  if (bound.size === 0) perStream.delete(streamId);
  return { wasSubscribed: true };
}

export function listStreamSubscriptions(
  streamId: StreamTabId,
): readonly string[] {
  return [...(perStream.get(streamId)?.keys() ?? [])];
}
