/**
 * Bind execution-status subscriptions to agent stream lifecycles.
 *
 * Each (streamId, executionId) pair holds one disposer registered with the
 * execution registry's persistent listener API. Status transitions, kills,
 * and the final "untrack" event all fire as follow-ups into the subscriber
 * stream's queue, wrapped in `<execution-activity>` so the agent can
 * distinguish them from user input.
 *
 * Subscriptions self-dispose when the execution finishes (handle removed
 * from the registry) and when the subscriber stream's queue is released.
 */

import { createChannelTrace } from '@agent/trace';
import type {
  ExecutionHandle,
  ExecutionRegistry,
} from '@agent/runtime/executionRegistry';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { sendFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import type { StreamTabId } from '@shared/schemas';
import { wrapAndSanitizeTag } from '@utils/text/sanitizeTag';
import { currentSession, type SessionHandle } from './SessionHandle';

const logger = createChannelTrace('ExecutionSubscriptionBinder');

const TAG = DELIVERY_TAG.executionActivity;

interface Disposable {
  dispose: () => void;
}

type PerStream = Map<string, Disposable>;

interface ReleaseSource {
  onRelease(observer: (streamId: StreamTabId) => void): () => void;
}

interface BinderLogger {
  info(message: string, options?: { data?: unknown }): void;
  warn(message: string, options?: { data?: unknown }): void;
}

interface ExecutionSubscriptionBinderOptions {
  registry?: Pick<ExecutionRegistry, 'addListener' | 'getHandle' | 'getStatus'>;
  releaseSource?: ReleaseSource;
  logger?: BinderLogger;
  session?: SessionHandle;
}

interface SnapshotState {
  status: string;
  elapsed: string | null;
}

function snapshot(
  registry: Pick<ExecutionRegistry, 'getStatus'>,
  handle: ExecutionHandle,
): SnapshotState {
  const info = registry.getStatus(handle);
  return {
    status: info.status,
    elapsed: info.elapsed,
  };
}

function emitQueuedFollowUpsChanged(
  streamId: StreamTabId,
  session?: SessionHandle,
): void {
  const target = session ?? currentSession();
  target.events.emit({
    scope: 'session',
    event: { type: 'updateQueuedFollowUps', payload: { streamId } },
  });
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
    private readonly logger: BinderLogger,
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
    if (!statusChanged) {
      this.last = current;
      return;
    }

    const transition = this.last
      ? `${this.last.status} → ${current.status}`
      : current.status;
    const elapsed = current.elapsed ? ` (${current.elapsed} elapsed)` : '';
    this.send(
      `${this.executionId} (${this.agentName}, ${this.category}) ${transition}${elapsed}`,
    );
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
    )
      .then((result) => {
        if (result.status === 'sent' || result.status === 'queued') {
          emitQueuedFollowUpsChanged(this.streamId, this.session);
        }
      })
      .catch((err: unknown) => {
        this.logger.warn('Failed to deliver execution subscription follow-up', {
          data: { executionId: this.executionId, streamId: this.streamId, err },
        });
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
    // Unreachable in production: `SessionHandle` always passes both `registry`
    // and `releaseSource` explicitly (its own owned `executions`/`followUps`).
    // These fall back through `currentSession()` — never a standalone
    // singleton import — so a bare `new ExecutionSubscriptionBinder()` still
    // resolves to the caller's session instead of a hidden module export.
    this.registry = options.registry ?? currentSession().executions;
    this.releaseSource = options.releaseSource ?? currentSession().followUps;
    this.logger = options.logger ?? logger;
    this.session = options.session;
  }

  /**
   * Subscribe `streamId` to status and termination events for `executionId`.
   * Subsequent calls for the same pair are no-ops. Throws if the execution is
   * not currently tracked — terminal executions cannot be subscribed (use
   * `executions view` to read the final report).
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
      this.logger,
      () => this.removeBoundKey(streamId, executionId),
      this.session,
    );
    bound.set(executionId, subscription);
    if (subscription.bind()) {
      this.logger.info('Bound execution subscription to stream', {
        data: { executionId, streamId },
      });
    }
  }

  /**
   * Returns true if a subscription existed and was removed for this
   * (stream, execution) pair.
   */
  unbind(streamId: StreamTabId, executionId: string): boolean {
    const d = this.perStream.get(streamId)?.get(executionId);
    if (!d) return false;
    try {
      d.dispose();
    } catch (err) {
      this.logger.warn('Disposer threw on explicit unsubscribe', {
        data: err,
      });
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
        this.logger.warn(`Disposer threw during ${reason}`, { data: err });
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
