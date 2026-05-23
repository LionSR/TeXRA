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
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { createChannelTrace } from '@logger';
import type { StreamTabId } from '@shared/schemas';
import { wrapAndSanitizeTag } from '@utils/text/sanitizeTag';

const logger = createChannelTrace('ExecutionSubscriptionBinder');

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

class ExecutionSubscription implements Disposable {
  private readonly executionId: string;
  private readonly agentName: string;
  private readonly category: ExecutionHandle['category'];
  private last: SnapshotState | null;
  private removeListener: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly streamId: StreamTabId,
    handle: ExecutionHandle,
    private readonly runtimeHost: AgentRuntimeHost,
  ) {
    this.executionId = handle.executionId;
    this.agentName = handle.agentName;
    this.category = handle.category;
    this.last = snapshot(handle);
  }

  bind(): boolean {
    this.removeListener = addExecutionListener(this.executionId, (handle) => {
      this.handleChange(handle);
    });

    // TOCTOU: handle could untrack between the initial getHandle() check
    // and listener registration. Re-check; if gone, fire the terminal event
    // and dispose so the listener never leaks.
    if (!getHandle(this.executionId)) {
      this.sendFinished();
      this.dispose();
      return false;
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeListener?.();
    const current = perStream.get(this.streamId);
    if (current) removeBoundKey(this.streamId, current, this.executionId);
  }

  private handleChange(handle: ExecutionHandle | undefined): void {
    if (!handle) {
      this.sendFinished();
      this.dispose();
      return;
    }

    const current = snapshot(handle);
    const statusChanged = !this.last || this.last.status !== current.status;
    const roundChanged = this.last?.round !== current.round;
    if (!statusChanged && !roundChanged) {
      this.last = current;
      return;
    }

    const transition =
      this.last && statusChanged
        ? `${this.last.status} → ${current.status}`
        : current.status;
    const elapsed = current.elapsed ? ` (${current.elapsed} elapsed)` : '';
    const lines = [
      `${this.executionId} (${this.agentName}, ${this.category}) ${transition}${elapsed}`,
    ];
    if (current.round) lines.push(current.round);
    this.send(lines.join('\n'));
    this.last = current;
  }

  private sendFinished(): void {
    const previous = this.last?.status ?? 'unknown';
    this.send(
      `${this.executionId} (${this.agentName}, ${this.category}) finished. Last known status: ${previous}. Use executions { path: '/executions/${this.executionId}/report' } for the result.`,
    );
  }

  private send(text: string): void {
    void sendFollowUp(this.streamId, wrapAndSanitizeTag(TAG, text)).then(
      (result) => {
        if (result.status === 'sent' || result.status === 'queued') {
          this.runtimeHost.emit('updateQueuedFollowUps', {
            streamId: this.streamId,
          });
        }
      },
    );
  }
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
  runtimeHost: AgentRuntimeHost,
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

  const subscription = new ExecutionSubscription(streamId, handle, runtimeHost);
  bound.set(executionId, subscription);
  if (subscription.bind()) {
    logger.info(
      `Bound execution subscription ${executionId} → stream ${streamId}`,
    );
  }
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
  return true;
}
