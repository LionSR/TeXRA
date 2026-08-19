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
    try {
      return await this.exec(prepRes);
    } catch (error) {
      // execFallback's contract is `error: Error`. Normalize exactly as
      // p-retry does, so a node that throws a non-Error still reaches its
      // fallback with something that has `.message`.
      return await this.execFallback(
        prepRes,
        error instanceof Error
          ? error
          : new TypeError(
              `Non-error was thrown: "${error}". You should only throw errors.`,
            ),
      );
    }
  }
  /**
   * Handle a failed exec(). The default rethrows, so a node that does not
   * override this fails its flow. Override to convert the failure into a
   * value the node's post() can route on.
   */
  async execFallback(_prepRes: unknown, error: Error): Promise<unknown> {
    throw error;
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
export { BaseNode, Flow };
