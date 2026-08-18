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

import type {
  AgentExecutionHandle,
  ExecutionStatusInfo,
} from '@agent/runtime/ExecutionHandle';
import type { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { deliverLiveNotification } from '@agent/followUp/liveNotification';
import { createLog } from '@logger/logUtils';
import type { StreamTabId } from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { wrapAndSanitizeTag } from '@utils/text/sanitizeTag';
import { currentSession, type SessionHandle } from './SessionHandle';

const logger = createLog('ExecutionSubscriptionBinder');

const TAG = DELIVERY_TAG.executionActivity;

/**
 * Composite key so one flat map replaces the (streamId -> executionId ->
 * subscription) nesting. Built from `JSON.stringify(streamId)` rather than
 * plain concatenation: `StreamTabIdSchema` (`z.string().min(1)`) does not
 * forbid any particular character, so a delimiter-based key could alias two
 * distinct (streamId, executionId) pairs if an id ever contained it.
 * `JSON.stringify` is self-delimiting (its closing quote cannot be faked by
 * a longer or differently-escaped string), so `streamKeyPrefix`'s
 * `startsWith` check cannot collide across streams regardless of id content.
 */
type SubscriptionKey = string;

function streamKeyPrefix(streamId: StreamTabId): string {
  return `${JSON.stringify(streamId)}:`;
}

function subscriptionKey(
  streamId: StreamTabId,
  executionId: string,
): SubscriptionKey {
  return `${streamKeyPrefix(streamId)}${JSON.stringify(executionId)}`;
}

interface ReleaseSource {
  onRelease(observer: (streamId: StreamTabId) => void): () => void;
  currentGenerationId?(streamId: StreamTabId): string | undefined;
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

class ExecutionSubscription {
  private readonly executionId: string;
  private readonly agentName: string;
  private readonly category: AgentExecutionHandle['category'];
  private last: ExecutionStatusInfo;
  private removeListener: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly streamId: StreamTabId,
    handle: AgentExecutionHandle,
    private readonly registry: Pick<
      ExecutionRegistry,
      'addListener' | 'getHandle' | 'getStatus'
    >,
    private readonly logger: BinderLogger,
    private readonly onDisposed: () => void,
    private readonly expectedGenerationId: string | undefined,
    private readonly session?: SessionHandle,
  ) {
    this.executionId = handle.executionId;
    this.agentName = handle.agentName;
    this.category = handle.category;
    this.last = this.registry.getStatus(handle);
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
    // onDisposed() must run even if removeListener throws — it is the only
    // path that removes this subscription's entry from the binder's map, and
    // a leaked map entry blocks a future bind() for the same (streamId,
    // executionId) pair from ever succeeding.
    try {
      this.removeListener?.();
    } finally {
      this.onDisposed();
    }
  }

  private handleChange(handle: AgentExecutionHandle | undefined): void {
    if (!handle) {
      this.sendFinished();
      this.dispose();
      return;
    }

    const current = this.registry.getStatus(handle);
    const previous = this.last;
    if (previous.status === current.status) {
      this.last = current;
      return;
    }

    const elapsed = current.elapsed ? ` (${current.elapsed} elapsed)` : '';
    this.send(
      `${this.executionId} (${this.agentName}, ${this.category}) ` +
        `${previous.status} → ${current.status}${elapsed}`,
    );
    this.last = current;
  }

  private sendFinished(): void {
    this.send(
      `${this.executionId} (${this.agentName}, ${this.category}) finished. Last known status: ${this.last.status}. Use executions { path: '/executions/${this.executionId}/report' } for the result.`,
    );
  }

  private send(text: string): void {
    deliverLiveNotification({
      streamId: this.streamId,
      followUp: wrapAndSanitizeTag(TAG, text),
      session: this.session,
      expectedGenerationId: this.expectedGenerationId,
      logger: this.logger,
      failure: {
        message: 'Failed to deliver execution subscription follow-up',
        data: { executionId: this.executionId, streamId: this.streamId },
      },
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
  private readonly subscriptions = new Map<
    SubscriptionKey,
    ExecutionSubscription
  >();
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
  bind(streamId: StreamTabId, executionId: string): void {
    this.ensureReleaseHook();

    const handle = this.registry.getHandle(executionId);
    if (!handle) {
      throw new Error(
        `Execution ${executionId} is not active. Subscribe only works on tracked executions; use 'view' to read the final report.`,
      );
    }

    const key = subscriptionKey(streamId, executionId);
    if (this.subscriptions.has(key)) return;

    const subscription = new ExecutionSubscription(
      streamId,
      handle,
      this.registry,
      this.logger,
      () => this.subscriptions.delete(key),
      this.releaseSource.currentGenerationId?.(streamId),
      this.session,
    );
    this.subscriptions.set(key, subscription);
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
    const subscription = this.subscriptions.get(
      subscriptionKey(streamId, executionId),
    );
    if (!subscription) return false;
    try {
      subscription.dispose();
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
    this.disposeMatching(() => true, 'binder disposal');
  }

  private ensureReleaseHook(): void {
    if (this.releaseHook) return;
    this.releaseHook = this.releaseSource.onRelease((streamId) => {
      const prefix = streamKeyPrefix(streamId);
      this.disposeMatching((key) => key.startsWith(prefix), 'release');
    });
  }

  private disposeMatching(
    matches: (key: SubscriptionKey) => boolean,
    reason: string,
  ): void {
    for (const [key, subscription] of [...this.subscriptions]) {
      if (!matches(key)) continue;
      try {
        subscription.dispose();
      } catch (err) {
        this.logger.warn(`Disposer threw during ${reason}`, { data: err });
      }
    }
  }
}
