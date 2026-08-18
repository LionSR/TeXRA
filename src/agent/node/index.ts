import pRetry, { AbortError } from 'p-retry';

import { createLog } from '@logger/logUtils';

/** Flow transition action - typically 'default' or a custom action name */
export type Action = string;

const log = createLog('PocketFlow');
// Actions that deliberately end a flow when a node returns them with no
// registered successor. `finalize` is the reflection flow's terminal action on
// failure (ResponseCycleNode.post → FlowTransition.FINALIZE); without listing it
// here, getNextNode logs a spurious "Flow ends: 'finalize' not found" warning on
// every reflection-flow failure even though ending is the intended behavior.
const TERMINAL_ACTIONS = new Set<Action>(['complete', 'finalize']);

/**
 * Base node class for PocketFlow.
 *
 * Type parameters:
 * - S: Shared state type (mutable, flows through nodes)
 * - Svc: Services type (immutable dependencies, set once)
 *
 * Architecture:
 * - shared: Mutable state passed through prep/post
 * - _services: Immutable dependencies (propagated by Flow)
 */
class BaseNode<S = unknown, Svc = unknown> {
  protected _services: Svc | undefined;
  protected _successors: Map<Action, BaseNode> = new Map();

  /**
   * Get typed services. Override in subclasses for better typing.
   * Throws rather than returning a fabricated empty object — a node that
   * reads services before Flow.setServices() propagated them is a real bug,
   * not a case to paper over.
   */
  get services(): Svc {
    if (this._services === undefined) {
      throw new Error(
        'Node services accessed before Flow.setServices() populated them.',
      );
    }
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
      log.warn("Node won't run successors. Use Flow.");
    return await this._run(shared);
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
      log.warn(`Overwriting successor for action '${action}'`);
    this._successors.set(action, node);
    return this;
  }
  getNextNode(action: Action = 'default'): BaseNode | undefined {
    const next = this._successors.get(action);
    if (!next && TERMINAL_ACTIONS.has(action)) return undefined;
    if (!next && this._successors.size > 0) {
      log.warn(
        `Flow ends: '${action}' not found in [${[...this._successors.keys()]}]`,
      );
    }
    return next;
  }
  /** Successor table used by persisted flows to build graph-local replay cursors. */
  successorEntries(): readonly [Action, BaseNode][] {
    return [...this._successors.entries()];
  }
  clone(): this {
    const clonedNode = Object.create(Object.getPrototypeOf(this));
    Object.assign(clonedNode, this);
    // Services are immutable, shallow copy is safe
    clonedNode._services = this._services;
    clonedNode._successors = new Map(this._successors);
    return clonedNode;
  }
}
class Node<S = unknown, Svc = unknown> extends BaseNode<S, Svc> {
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
    if (maxRetries < 1) {
      throw new RangeError(`Node maxRetries must be >= 1, got ${maxRetries}.`);
    }
    this.maxRetries = maxRetries;
    this.wait = wait;
  }

  async execFallback(prepRes: unknown, error: Error): Promise<unknown> {
    throw error;
  }
  /**
   * Hook called when the automatic retry batch is exhausted or declined.
   * Return true to grant one additional attempt, false to proceed to execFallback.
   * A failed additional attempt calls this hook again.
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
   * class MyNode extends Node<S> {
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
    const effectiveMaxRetries = this.maxRetries;

    // Track the last exec error so we can forward it to execFallback when
    // the abort signal fires during the inter-retry delay (p-retry would
    // otherwise rethrow signal.reason, discarding the original failure).
    let lastExecError: Error | undefined;
    let attemptThrew = false;
    const runAttempts = async (retries: number): Promise<unknown> => {
      attemptThrew = false;
      return await pRetry(
        async () => {
          // Throw AbortError at each attempt start so p-retry surfaces it
          // immediately (before any delay) and skips onFailedAttempt.
          if (this.signal?.aborted)
            throw new AbortError('Operation cancelled by user');
          try {
            return await this.exec(prepRes);
          } catch (error) {
            attemptThrew = true;
            throw error;
          }
        },
        {
          retries,
          minTimeout: this.wait * 1000,
          factor: 1, // linear (fixed) delay to preserve existing behaviour
          randomize: false, // explicit: default is false; no jitter on fixed delays
          signal: this.signal, // aborts an attempt or inter-retry delay early
          shouldRetry: ({ error }) => {
            lastExecError = error;
            if (this.signal?.aborted) return false;
            return this.shouldAutoRetry(error);
          },
        },
      );
    };

    let retryError: Error;
    try {
      return await runAttempts(effectiveMaxRetries - 1);
    } catch (e) {
      // User cancellation surfaces here as p-retry's aborted-delay rejection
      // (signal.reason) or as the unwrapped error from our pre-attempt check
      // (p-retry rethrows an AbortError's originalError, not the AbortError).
      // Forward the recorded exec failure when one exists.
      if (this.signal?.aborted) {
        return await this.execFallback(prepRes, lastExecError ?? (e as Error));
      }
      retryError = e as Error;
    }

    for (;;) {
      const shouldRetry = await this.retryPrompt(prepRes, retryError);
      if (!shouldRetry || this.signal?.aborted) {
        return await this.execFallback(prepRes, retryError);
      }

      try {
        return await runAttempts(0);
      } catch (e) {
        const approvedError = e as Error;
        if (this.signal?.aborted) {
          return await this.execFallback(
            prepRes,
            attemptThrew ? approvedError : retryError,
          );
        }
        retryError = approvedError;
      }
    }
  }
}
class Flow<S = unknown, Svc = unknown> extends BaseNode<S, Svc> {
  start: BaseNode;
  constructor(start: BaseNode) {
    super();
    this.start = start;
  }
  protected async _orchestrate(shared: S): Promise<void> {
    let current: BaseNode | undefined = this.start.clone();
    while (current) {
      // Propagate services to each node (immutable, same instance)
      current.setServices(this._services);
      const action = await current._run(shared);
      current = current.getNextNode(action)?.clone();
    }
  }
  async _run(shared: S): Promise<Action | undefined> {
    const pr = await this.prep(shared);
    await this._orchestrate(shared);
    return await this.post(shared, pr, undefined);
  }
  async exec(_prepRes: unknown): Promise<unknown> {
    throw new Error("Flow can't exec.");
  }
}
export { BaseNode, Node, Flow };
