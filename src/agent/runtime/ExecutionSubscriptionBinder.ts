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
  executionRegistry,
  type ExecutionHandle,
  type ExecutionProgress,
  type ExecutionRegistry,
} from '@agent/runtime/executionRegistry';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { sendFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { createChannelTrace } from '@logger';
import type { StreamTabId } from '@shared/schemas';
import { wrapAndSanitizeTag } from '@utils/text/sanitizeTag';
import type { SessionHandle } from './SessionHandle';

const logger = createChannelTrace('ExecutionSubscriptionBinder');

const TAG = 'execution-activity';

interface Disposable {
  dispose: () => void;
}

type PerStream = Map<string, Disposable>;

interface ReleaseSource {
  onRelease(observer: (streamId: StreamTabId) => void): () => void;
}

interface BinderLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface ExecutionSubscriptionBinderOptions {
  registry?: Pick<ExecutionRegistry, 'addListener' | 'getHandle' | 'getStatus'>;
  releaseSource?: ReleaseSource;
  logger?: BinderLogger;
  session?: SessionHandle;
}

function progressLine(progress: ExecutionProgress | undefined): string | null {
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

function snapshot(
  registry: Pick<ExecutionRegistry, 'getStatus'>,
  handle: ExecutionHandle,
): SnapshotState {
  const info = registry.getStatus(handle);
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
    private readonly registry: Pick<
      ExecutionRegistry,
      'addListener' | 'getHandle' | 'getStatus'
    >,
    private readonly onDisposed: () => void,
    private readonly session?: SessionHandle,
  ) {
    this.executionId = handle.executionId;
    this.agentName = handle.agentName;
    this.category = handle.category;
    this.last = snapshot(this.registry, handle);
  }

  bind(): boolean {
    this.removeListener = this.registry.addListener(
      this.executionId,
      (handle) => {
        this.handleChange(handle);
      },
    );

    // TOCTOU: handle could untrack between the initial registry.getHandle()
    // check and listener registration. Re-check; if gone, fire the terminal
    // event and dispose so the listener never leaks.
    if (!this.registry.getHandle(this.executionId)) {
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
    this.onDisposed();
  }

  private handleChange(handle: ExecutionHandle | undefined): void {
    if (!handle) {
      this.sendFinished();
      this.dispose();
      return;
    }

    const current = snapshot(this.registry, handle);
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
    void sendFollowUp(
      this.streamId,
      wrapAndSanitizeTag(TAG, text),
      undefined,
      undefined,
      this.session,
    ).then((result) => {
      if (result.status === 'sent' || result.status === 'queued') {
        this.runtimeHost.emit('updateQueuedFollowUps', {
          streamId: this.streamId,
        });
      }
    });
  }
}

export class ExecutionSubscriptionBinder {
  private readonly registry: Pick<
    ExecutionRegistry,
    'addListener' | 'getHandle' | 'getStatus'
  >;
  private readonly releaseSource: ReleaseSource;
  private readonly logger: BinderLogger;
  private readonly session?: SessionHandle;
  private readonly perStream = new Map<StreamTabId, PerStream>();
  private releaseHook: (() => void) | undefined;

  constructor(options: ExecutionSubscriptionBinderOptions = {}) {
    this.registry = options.registry ?? executionRegistry;
    this.releaseSource = options.releaseSource ?? ToolUseFollowUpQueue;
    this.logger = options.logger ?? logger;
    this.session = options.session;
  }

  /**
   * Subscribe `streamId` to status, progress, and termination events for
   * `executionId`. Subsequent calls for the same pair are no-ops. Throws if
   * the execution is not currently tracked — terminal executions cannot be
   * subscribed (use `executions view` to read the final report).
   */
  bind(
    streamId: StreamTabId,
    executionId: string,
    runtimeHost: AgentRuntimeHost,
  ): void {
    this.ensureReleaseHook();

    const handle = this.registry.getHandle(executionId);
    if (!handle) {
      throw new Error(
        `Execution ${executionId} is not active. Subscribe only works on tracked executions; use 'view' to read the final report.`,
      );
    }

    let bound = this.perStream.get(streamId);
    if (!bound) {
      bound = new Map();
      this.perStream.set(streamId, bound);
    }
    if (bound.has(executionId)) return;

    const subscription = new ExecutionSubscription(
      streamId,
      handle,
      runtimeHost,
      this.registry,
      () => this.removeBoundKey(streamId, executionId),
      this.session,
    );
    bound.set(executionId, subscription);
    if (subscription.bind()) {
      this.logger.info(
        `Bound execution subscription ${executionId} → stream ${streamId}`,
      );
    }
  }

  /**
   * Returns true if a subscription existed and was removed for this
   * (stream, execution) pair.
   */
  unbind(streamId: StreamTabId, executionId: string): boolean {
    const bound = this.perStream.get(streamId);
    const d = bound?.get(executionId);
    if (!bound || !d) return false;
    try {
      d.dispose();
    } catch (err) {
      this.logger.warn(
        `Disposer threw on explicit unsubscribe: ${String(err)}`,
      );
    }
    return true;
  }

  dispose(): void {
    this.releaseHook?.();
    this.releaseHook = undefined;
    for (const bound of [...this.perStream.values()]) {
      this.disposeBoundSubscriptions(bound, 'binder disposal');
    }
    this.perStream.clear();
  }

  private ensureReleaseHook(): void {
    if (this.releaseHook) return;
    this.releaseHook = this.releaseSource.onRelease((streamId) => {
      const bound = this.perStream.get(streamId);
      if (!bound) return;
      this.disposeBoundSubscriptions(bound, 'release');
      this.perStream.delete(streamId);
    });
  }

  private disposeBoundSubscriptions(bound: PerStream, reason: string): void {
    for (const d of [...bound.values()]) {
      try {
        d.dispose();
      } catch (err) {
        this.logger.warn(`Disposer threw during ${reason}: ${String(err)}`);
      }
    }
  }

  private removeBoundKey(streamId: StreamTabId, executionId: string): void {
    const bound = this.perStream.get(streamId);
    if (!bound) return;
    bound.delete(executionId);
    if (bound.size === 0) this.perStream.delete(streamId);
  }
}

export const executionSubscriptionBinder = new ExecutionSubscriptionBinder();
