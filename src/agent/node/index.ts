import { Duration, Effect, Schedule } from 'effect';
import { AbortError } from 'p-retry';

import { createLog } from '@logger/logUtils';
import { ensureError } from '@utils/errors/errorMessage';

/** Flow transition action - typically 'default' or a custom action name */
export type Action = string;

const log = createLog('PocketFlow');
// Actions that deliberately end a flow when a node returns them with no
// registered successor. `finalize` is the reflection flow's terminal action on
// failure (ResponseCycleNode.post → FlowTransition.FINALIZE); without listing it
// here, getNextNode logs a spurious "Flow ends: 'finalize' not found" warning on
// every reflection-flow failure even though ending is the intended behavior.
// (`waiting` is not terminal — ToolUseWaitNode wires it as a self-loop successor.)
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
    if (this.maxRetries < 1) {
      log.warn(
        `Node maxRetries must be >= 1, got ${this.maxRetries}. Using 1.`,
      );
    }
    const autoRetries = Math.max(1, this.maxRetries) - 1;

    // State the Effect error channel cannot carry: on abort we must forward
    // the last *exec* failure rather than the cancellation, and the manual
    // phase must collapse the automatic schedule to a single attempt.
    let lastExecError: Error | undefined;
    let attemptThrew = false;
    let manualPhase = false;

    const cancelled = (): Error =>
      lastExecError ?? new Error('Operation cancelled by user');

    const attempt = Effect.suspend(() => {
      attemptThrew = false;
      if (this.signal?.aborted) return Effect.fail(cancelled());
      return Effect.tryPromise({
        try: () => this.exec(prepRes),
        catch: (cause) => {
          attemptThrew = true;
          // p-retry stays the retry engine under `src/tools`, so a tool can
          // still surface its `AbortError` wrapper here; unwrap to the error
          // the prompt and fallback are supposed to see.
          lastExecError = ensureError(
            cause instanceof AbortError
              ? (cause.originalError ?? cause)
              : cause,
          );
          return lastExecError;
        },
      }).pipe(
        // Must run to completion: fiber interruption would cancel the `catch`
        // above, losing which error the fallback has to forward.
        Effect.uninterruptible,
        // An abort that lands mid-attempt discards a late success.
        Effect.flatMap((value) =>
          this.signal?.aborted
            ? Effect.fail(cancelled())
            : Effect.succeed(value),
        ),
      );
    });

    const automatic = Schedule.recurs(autoRetries).pipe(
      Schedule.addDelay(() => Duration.millis(this.wait * 1000)),
      Schedule.check(() => !manualPhase),
    );

    const program = attempt.pipe(
      Effect.retry({
        schedule: automatic,
        while: (error) =>
          this.signal?.aborted !== true && this.shouldAutoRetry(error),
      }),
      Effect.retry({
        while: (error) =>
          Effect.promise(async () => {
            if (this.signal?.aborted) return false;
            manualPhase = true;
            const granted = await this.retryPrompt(prepRes, error);
            return granted && this.signal?.aborted !== true;
          }),
      }),
      Effect.catchAll((error) =>
        Effect.promise(() => this.execFallback(prepRes, error)),
      ),
    );

    try {
      // The signal drives fiber interruption so an abort lands during the
      // inter-retry delay; attempts above are uninterruptible, so a pending
      // interrupt is deferred until the in-flight attempt has recorded its
      // outcome.
      return await Effect.runPromise(program, { signal: this.signal });
    } catch {
      // Only interruption escapes `catchAll`.
      return await this.execFallback(prepRes, cancelled());
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
