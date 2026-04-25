/**
 * Bind execution-status subscriptions to agent stream lifecycles.
 *
 * Each (streamId, executionId) pair holds one disposer registered with the
 * execution registry's persistent listener API. Status transitions, progress
 * updates, kills, and the final "untrack" event all fire as follow-ups into
 * the subscriber stream's queue, wrapped in `<execution-activity>` so the
 * agent can distinguish them from user input.
 *
 * Subscriptions self-dispose when the execution finishes (handle removed
 * from the registry) and when the subscriber stream's queue is released.
 */

import {
  addExecutionListener,
  getHandle,
} from '@agent/runtime/executionRegistry';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import type { StreamTabId } from '@shared/schemas';

const logger = new AgentLogger('ExecutionSubscriptionBinder');

const OPEN_TAG = '<execution-activity>';
const CLOSE_TAG = '</execution-activity>';

/**
 * Strip any literal `<execution-activity>` / `</execution-activity>` tokens
 * from interpolated content so a malicious agent name or report cannot escape
 * the wrapper. Mirrors the sanitizer in formatPREvent.ts.
 */
function sanitize(s: string): string {
  return s.replaceAll(/<\s*\/?\s*execution-activity\s*>/gi, (match) =>
    match.replace(/execution-activity/i, 'execution-​activity'),
  );
}

function wrap(inner: string): string {
  return `${OPEN_TAG}\n${sanitize(inner)}\n${CLOSE_TAG}`;
}

interface Disposable {
  dispose: () => void;
}

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

function removeBoundKey(
  streamId: StreamTabId,
  bound: PerStream,
  executionId: string,
): void {
  bound.delete(executionId);
  if (bound.size === 0) perStream.delete(streamId);
}

function progressLine(
  progress: { currentRound?: number; totalRounds?: number } | undefined,
): string | null {
  if (
    !progress ||
    progress.currentRound === undefined ||
    progress.totalRounds === undefined
  ) {
    return null;
  }
  return `Progress: round ${progress.currentRound + 1}/${progress.totalRounds}`;
}

interface SnapshotState {
  status: string;
  elapsed: string | null;
  round: string | null;
}

function snapshot(executionId: string): SnapshotState | null {
  const handle = getHandle(executionId);
  if (!handle) return null;
  const info = handle.getStatus();
  return {
    status: info.status,
    elapsed: info.elapsed,
    round: progressLine(handle.getProgress()),
  };
}

/**
 * Returns true if a new subscription was created, false if it already
 * existed for this (stream, execution) pair. Throws if the execution is
 * not currently tracked — terminal executions cannot be subscribed.
 */
export function bindExecutionSubscription(
  streamId: StreamTabId,
  executionId: string,
): boolean {
  ensureReleaseHook();

  const handle = getHandle(executionId);
  if (!handle) {
    throw new Error(
      `Execution ${executionId} is not active. Subscribe only works on tracked executions; use 'view' to read the final report.`,
    );
  }

  let bound = perStream.get(streamId);
  if (!bound) {
    bound = new Map();
    perStream.set(streamId, bound);
  }
  if (bound.has(executionId)) return false;

  const agentName = handle.agentName;
  const category = handle.category;
  let last: SnapshotState | null = snapshot(executionId);

  // Sentinel so a synchronous re-entry sees the slot as taken.
  const sentinel: Disposable = { dispose: () => {} };
  bound.set(executionId, sentinel);

  let removeListener: (() => void) | null = null;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (removeListener) removeListener();
    const current = perStream.get(streamId);
    if (current) removeBoundKey(streamId, current, executionId);
  };

  const send = (text: string): void => {
    void sendFollowUp(streamId, wrap(text)).then((result) => {
      if (result.status === 'sent' || result.status === 'queued') {
        bus.emit('updateQueuedFollowUps', { streamId });
      }
    });
  };

  removeListener = addExecutionListener(executionId, () => {
    const current = snapshot(executionId);

    if (!current) {
      // Handle gone — execution finished. Emit one final event then dispose.
      const previous = last?.status ?? 'unknown';
      send(
        `${executionId} (${agentName}, ${category}) finished. Last known status: ${previous}. Use executions { path: '/executions/${executionId}/report' } for the result.`,
      );
      dispose();
      return;
    }

    const statusChanged = !last || last.status !== current.status;
    const roundChanged = last?.round !== current.round;
    if (!statusChanged && !roundChanged) {
      last = current;
      return;
    }

    const transition = last
      ? `${last.status} → ${current.status}`
      : current.status;
    const lines = [
      `${executionId} (${agentName}, ${category}) ${transition}${
        current.elapsed ? ` (${current.elapsed} elapsed)` : ''
      }`,
    ];
    if (current.round) lines.push(current.round);
    send(lines.join('\n'));
    last = current;
  });

  bound.set(executionId, { dispose });
  logger.info(
    `Bound execution subscription ${executionId} → stream ${streamId}`,
  );
  return true;
}

/**
 * Returns true if a subscription existed and was removed for this
 * (stream, execution) pair.
 */
export function unbindExecutionSubscription(
  streamId: StreamTabId,
  executionId: string,
): boolean {
  const bound = perStream.get(streamId);
  const d = bound?.get(executionId);
  if (!bound || !d) return false;
  try {
    d.dispose();
  } catch (err) {
    logger.warn(`Disposer threw on explicit unsubscribe: ${String(err)}`);
  }
  removeBoundKey(streamId, bound, executionId);
  return true;
}
