import * as logger from '@agent/core/logger';
import { delay } from '@utils/core';

export type NonIterableObject = Partial<Record<string, unknown>> & {
  [Symbol.iterator]?: never;
};

/** Flow transition action - typically 'default' or a custom action name */
export type Action = string;

const CHANNEL = 'PocketFlow';
const TERMINAL_ACTIONS = new Set<Action>(['complete']);
logger.initialize(CHANNEL);

/**
 * Base node class for PocketFlow.
 *
 * Type parameters:
 * - S: Shared state type (mutable, flows through nodes)
 * - P: Params type (per-execution parameters)
 * - Svc: Services type (immutable dependencies, set once)
 *
 * Architecture:
 * - shared: Mutable state passed through prep/post
 * - _params: Per-execution parameters
 * - _services: Immutable dependencies (propagated by Flow)
 */
class BaseNode<
  S = unknown,
  P extends NonIterableObject = NonIterableObject,
  Svc = unknown,
> {
  protected _params: P = {} as P;
  protected _services: Svc = {} as Svc;
  protected _successors: Map<Action, BaseNode> = new Map();

  /**
   * Get typed services. Override in subclasses for better typing.
   */
  get services(): Svc {
    return this._services;
  }

  protected async _exec(prepRes: unknown): Promise<unknown> {
    return await this.exec(prepRes);
  }
  async prep(_shared: S): Promise<unknown> {
    return;
  }
  async exec(_prepRes: unknown): Promise<unknown> {
    return;
  }
  async post(
    _shared: S,
    _prepRes: unknown,
    _execRes: unknown,
  ): Promise<Action | undefined> {
    return;
  }
  async _run(shared: S): Promise<Action | undefined> {
    const prepRes = await this.prep(shared);
    const execRes = await this._exec(prepRes);
    return await this.post(shared, prepRes, execRes);
  }
  async run(shared: S): Promise<Action | undefined> {
    if (this._successors.size > 0)
      logger.warn(CHANNEL, "Node won't run successors. Use Flow.");
    return await this._run(shared);
  }
  setParams(params: P): this {
    this._params = params;
    return this;
  }
  setServices(services: Svc): this {
    this._services = services;
    return this;
  }
  next<T extends BaseNode>(node: T): T {
    this.on('default', node);
    return node;
  }
  on(action: Action, node: BaseNode): this {
    if (this._successors.has(action))
      logger.warn(CHANNEL, `Overwriting successor for action '${action}'`);
    this._successors.set(action, node);
    return this;
  }
  getNextNode(action: Action = 'default'): BaseNode | undefined {
    const next = this._successors.get(action);
    if (!next && TERMINAL_ACTIONS.has(action)) return undefined;
    if (!next && this._successors.size > 0) {
      logger.warn(
        CHANNEL,
        `Flow ends: '${action}' not found in [${[...this._successors.keys()]}]`,
      );
    }
    return next;
  }
  clone(): this {
    const clonedNode = Object.create(Object.getPrototypeOf(this));
    Object.assign(clonedNode, this);
    clonedNode._params = { ...this._params };
    // Services are immutable, shallow copy is safe
    clonedNode._services = this._services;
    clonedNode._successors = new Map(this._successors);
    return clonedNode;
  }
}
class Node<
  S = unknown,
  P extends NonIterableObject = NonIterableObject,
  Svc = unknown,
> extends BaseNode<S, P, Svc> {
  maxRetries: number;
  wait: number;
  /**
   * Optional abort signal for cancellation support.
   * When set and aborted, the retry loop will skip remaining retries
   * and go directly to execFallback(). This prevents unnecessary API
   * calls when the user has intentionally cancelled the operation.
   */
  signal?: AbortSignal;
  constructor(maxRetries: number = 1, wait: number = 0) {
    super();
    this.maxRetries = maxRetries;
    this.wait = wait;
  }

  async execFallback(prepRes: unknown, error: Error): Promise<unknown> {
    throw error;
  }
  /**
   * Hook called when all auto-retries are exhausted.
   * Return true to restart the auto-retry loop, false to proceed to execFallback.
   *
   * Default implementation returns false (no manual retry).
   * Override this for manual retry prompts (e.g., showing UI to user).
   *
   * NOTE: Override this as a regular method (not an arrow function property)
   * because Node.clone() uses Object.assign, which copies instance properties.
   * Arrow functions capture `this` lexically, so they would reference the
   * original instance after cloning. Regular methods on the prototype work
   * correctly because they get `this` from the call site.
   *
   * @example
   * ```typescript
   * class MyNode extends Node<S, P> {
   *   async retryPrompt(prepRes: unknown, error: Error): Promise<boolean> {
   *     const result = await showRetryDialog(error.message);
   *     return result === 'retry';
   *   }
   * }
   * ```
   */
  async retryPrompt(_prepRes: unknown, _error: Error): Promise<boolean> {
    return false;
  }
  /**
   * Whether this error should be auto-retried (silent retries with backoff).
   * Return false to skip auto-retries and go straight to retryPrompt().
   * Useful for errors that need human attention (e.g., auth errors).
   *
   * Default: true (all errors are auto-retried).
   */
  shouldAutoRetry(_error: Error): boolean {
    return true;
  }
  /**
   * Override clone to reset execution-specific state.
   * Prevents stale signal/retry state from affecting new executions.
   *
   * NOTE: BaseNode.clone() uses Object.assign for shallow copy. Subclasses
   * adding object/array properties must override clone() to deep-copy them,
   * otherwise the original and clone will share the same references.
   */
  clone(): this {
    const cloned = super.clone();
    cloned.signal = undefined;
    return cloned;
  }
  async _exec(prepRes: unknown): Promise<unknown> {
    // Guard against infinite loop: ensure at least 1 retry attempt
    if (this.maxRetries < 1) {
      logger.warn(
        CHANNEL,
        `Node maxRetries must be >= 1, got ${this.maxRetries}. Using 1.`,
      );
    }
    const effectiveMaxRetries = Math.max(1, this.maxRetries);

    // Safety limit for manual retries to prevent infinite loops from buggy retryPrompt
    const MAX_MANUAL_RETRIES = 100;
    let manualRetryCount = 0;

    // Outer loop for manual retry (restarts auto-retry cycle)
    while (manualRetryCount < MAX_MANUAL_RETRIES) {
      for (
        let currentRetry = 0;
        currentRetry < effectiveMaxRetries;
        currentRetry++
      ) {
        // Check abort at start of each retry for responsive cancellation
        // This ensures we don't attempt exec when the user has already cancelled
        if (this.signal?.aborted) {
          const cancelError = new Error('Operation cancelled by user');
          return await this.execFallback(prepRes, cancelError);
        }
        try {
          return await this.exec(prepRes);
        } catch (e) {
          // If abort signal is set and aborted, skip retries and go to fallback
          // This prevents unnecessary retries when the user intentionally cancelled
          const isAborted = this.signal?.aborted;
          const isLastAutoRetry = currentRetry === effectiveMaxRetries - 1;
          const skipAutoRetry = !this.shouldAutoRetry(e as Error);

          if (isLastAutoRetry || isAborted || skipAutoRetry) {
            // Auto-retries exhausted - try manual retry (unless aborted)
            if (!isAborted) {
              const shouldRetry = await this.retryPrompt(prepRes, e as Error);
              if (shouldRetry) {
                manualRetryCount++;
                break; // Break inner loop to restart auto-retries
              }
            }
            return await this.execFallback(prepRes, e as Error);
          }
          if (this.wait > 0) {
            await delay(this.wait * 1000);
            // Check abort after delay to exit quickly if cancelled during wait
            if (this.signal?.aborted) {
              return await this.execFallback(prepRes, e as Error);
            }
          }
        }
      }
      // If we broke from inner loop, continue outer loop to restart auto-retries
    }

    // Safeguard: if we somehow exit the loop without returning, throw
    throw new Error(
      `Node exceeded maximum manual retry limit (${MAX_MANUAL_RETRIES})`,
    );
  }
}
class BatchNode<
  S = unknown,
  P extends NonIterableObject = NonIterableObject,
  Svc = unknown,
> extends Node<S, P, Svc> {
  async _exec(items: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(items)) return [];
    const results = [];
    for (const item of items) {
      // Check abort signal before each batch item for responsive cancellation
      if (this.signal?.aborted) break;
      results.push(await super._exec(item));
    }
    return results;
  }
}
class ParallelBatchNode<
  S = unknown,
  P extends NonIterableObject = NonIterableObject,
  Svc = unknown,
> extends Node<S, P, Svc> {
  async _exec(items: unknown[]): Promise<unknown[]> {
    if (!Array.isArray(items)) return [];
    // Check abort signal before starting parallel execution
    if (this.signal?.aborted) return [];
    const results = await Promise.all(items.map((item) => super._exec(item)));
    // Note: Can't abort mid-execution, but at least we check before starting
    return results;
  }
}
class Flow<
  S = unknown,
  P extends NonIterableObject = NonIterableObject,
  Svc = unknown,
> extends BaseNode<S, P, Svc> {
  start: BaseNode;
  constructor(start: BaseNode) {
    super();
    this.start = start;
  }
  protected async _orchestrate(shared: S, params?: P): Promise<void> {
    let current: BaseNode | undefined = this.start.clone();
    const p = params ?? this._params;
    while (current) {
      current.setParams(p);
      // Propagate services to each node (immutable, same instance)
      current.setServices(this._services);
      const action = await current._run(shared);
      current = current.getNextNode(action);
      current = current?.clone();
    }
  }
  async _run(shared: S): Promise<Action | undefined> {
    const pr = await this.prep(shared);
    await this._orchestrate(shared);
    return await this.post(shared, pr, undefined);
  }
  async exec(prepRes: unknown): Promise<unknown> {
    throw new Error("Flow can't exec.");
  }
}
export { BaseNode, Node, BatchNode, ParallelBatchNode, Flow };
