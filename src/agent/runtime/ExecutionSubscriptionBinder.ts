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
  type ExecutionHandle,
} from '@agent/runtime/executionRegistry';
import {
  getAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { AgentLogger } from '@logger/AgentLogger';
import type { StreamTabId } from '@shared/schemas';
import { wrapAndSanitizeTag } from '@utils/text/sanitizeTag';

const logger = new AgentLogger('ExecutionSubscriptionBinder');

const TAG = 'execution-activity';

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

function snapshot(handle: ExecutionHandle): SnapshotState {
  const info = handle.getStatus();
  return {
    status: info.status,
    elapsed: info.elapsed,
    round: progressLine(handle.getProgress()),
  };
}

function send(
  streamId: StreamTabId,
  text: string,
  runtimeHost: AgentRuntimeHost,
): void {
  void sendFollowUp(streamId, wrapAndSanitizeTag(TAG, text)).then((result) => {
    if (result.status === 'sent' || result.status === 'queued') {
      runtimeHost.updateQueuedFollowUps({ streamId });
    }
  });
}

/**
 * Subscribe `streamId` to status, progress, and termination events for
 * `executionId`. Subsequent calls for the same pair are no-ops. Throws if
 * the execution is not currently tracked — terminal executions cannot be
 * subscribed (use `executions view` to read the final report).
 */
export function bindExecutionSubscription(
  streamId: StreamTabId,
  executionId: string,
): void {
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
  if (bound.has(executionId)) return;

  const agentName = handle.agentName;
  const category = handle.category;
  const subscriberRuntimeHost = getAgentRuntimeHost();
  let last: SnapshotState | null = snapshot(handle);

  let removeListener: (() => void) | null = null;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (removeListener) removeListener();
    const current = perStream.get(streamId);
    if (current) removeBoundKey(streamId, current, executionId);
  };

  removeListener = addExecutionListener(executionId, (h) => {
    if (!h) {
      const previous = last?.status ?? 'unknown';
      send(
        streamId,
        `${executionId} (${agentName}, ${category}) finished. Last known status: ${previous}. Use executions { path: '/executions/${executionId}/report' } for the result.`,
        subscriberRuntimeHost,
      );
      dispose();
      return;
    }

    const current = snapshot(h);
    const statusChanged = !last || last.status !== current.status;
    const roundChanged = last?.round !== current.round;
    if (!statusChanged && !roundChanged) {
      last = current;
      return;
    }

    const transition =
      last && statusChanged
        ? `${last.status} → ${current.status}`
        : current.status;
    const elapsed = current.elapsed ? ` (${current.elapsed} elapsed)` : '';
    const lines = [
      `${executionId} (${agentName}, ${category}) ${transition}${elapsed}`,
    ];
    if (current.round) lines.push(current.round);
    send(streamId, lines.join('\n'), subscriberRuntimeHost);
    last = current;
  });

  // TOCTOU: handle could untrack between the initial getHandle() check
  // and addExecutionListener registration. Re-check; if gone, fire the
  // terminal event synchronously and dispose so the listener never leaks.
  if (!getHandle(executionId)) {
    send(
      streamId,
      `${executionId} (${agentName}, ${category}) finished. Last known status: ${last?.status ?? 'unknown'}. Use executions { path: '/executions/${executionId}/report' } for the result.`,
      subscriberRuntimeHost,
    );
    dispose();
    return;
  }

  bound.set(executionId, { dispose });
  logger.info(
    `Bound execution subscription ${executionId} → stream ${streamId}`,
  );
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
