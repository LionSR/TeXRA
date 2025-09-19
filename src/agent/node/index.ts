type NonIterableObject = Partial<Record<string, unknown>> & {
  [Symbol.iterator]?: never;
};

export type NodeAction = string | undefined;

/**
 * Minimal building block for agent flows. Nodes follow a simple lifecycle:
 *   prep(shared) -> exec(prepRes) -> post(shared, prepRes, execRes).
 * Each step is optional; override the ones you need for a given node.
 */
export class BaseNode<
  Shared = unknown,
  Params extends NonIterableObject = NonIterableObject,
> {
  private params: Params;
  private successors: Map<string, BaseNode<Shared, Params>>;

  constructor(params?: Params) {
    this.params = (params ?? {}) as Params;
    this.successors = new Map();
  }

  protected getParams(): Params {
    return this.params;
  }

  public setParams(params: Params): this {
    this.params = params;
    return this;
  }

  protected async prep(shared: Shared): Promise<unknown> {
    return undefined;
  }

  protected async exec(prepRes: unknown): Promise<unknown> {
    return undefined;
  }

  protected async post(
    shared: Shared,
    prepRes: unknown,
    execRes: unknown,
  ): Promise<NodeAction> {
    return undefined;
  }

  /**
   * Execute logic for the node. Subclasses can override to customize the exec
   * stage without replacing the full lifecycle.
   */
  protected async execute(prepRes: unknown): Promise<unknown> {
    return this.exec(prepRes);
  }

  /**
   * Run the node by calling prep -> exec -> post.
   */
  public async run(shared: Shared): Promise<NodeAction> {
    const prepRes = await this.prep(shared);
    const execRes = await this.execute(prepRes);
    return await this.post(shared, prepRes, execRes);
  }

  // Successor management ------------------------------------------------------------------------

  public on(action: string, node: BaseNode<Shared, Params>): this {
    if (this.successors.has(action)) {
      console.warn(`Overwriting successor for action '${action}'`);
    }
    this.successors.set(action, node);
    return this;
  }

  public next<T extends BaseNode<Shared, Params>>(node: T): T {
    this.on('default', node);
    return node;
  }

  public getNextNode(
    action: NodeAction = 'default',
  ): BaseNode<Shared, Params> | undefined {
    const key = action ?? 'default';
    const next = this.successors.get(key);
    if (!next && this.successors.size > 0) {
      const available = Array.from(this.successors.keys()).join(', ');
      console.warn(`Flow ends: '${key}' not found in [${available}]`);
    }
    return next;
  }

  public clone(): this {
    const clonedNode = Object.create(Object.getPrototypeOf(this));
    Object.assign(clonedNode, this);
    clonedNode.params = { ...this.params };
    clonedNode.successors = new Map(this.successors);
    return clonedNode;
  }
}

/**
 * Convenience alias mirroring the historic API. Extends BaseNode without
 * adding behaviour so existing subclasses can extend Node directly.
 */
export class Node<
  Shared = unknown,
  Params extends NonIterableObject = NonIterableObject,
> extends BaseNode<Shared, Params> {}

/**
 * Sequentially execute exec() for each item produced by prep().
 */
export class BatchNode<
  Shared = unknown,
  Params extends NonIterableObject = NonIterableObject,
> extends Node<Shared, Params> {
  protected override async execute(items: unknown): Promise<unknown> {
    if (!Array.isArray(items)) {
      return [];
    }

    const results: unknown[] = [];
    for (const item of items) {
      results.push(await this.exec(item));
    }

    return results;
  }
}

/**
 * Run exec() for each item concurrently and return their aggregated results.
 */
export class ParallelBatchNode<
  Shared = unknown,
  Params extends NonIterableObject = NonIterableObject,
> extends Node<Shared, Params> {
  protected override async execute(items: unknown): Promise<unknown> {
    if (!Array.isArray(items)) {
      return [];
    }

    return await Promise.all(items.map((item) => this.exec(item)));
  }
}

/**
 * Orchestrates a collection of nodes as a simple state machine.
 */
export class Flow<
  Shared = unknown,
  Params extends NonIterableObject = NonIterableObject,
> extends BaseNode<Shared, Params> {
  private readonly start: BaseNode<Shared, Params>;

  constructor(start: BaseNode<Shared, Params>) {
    super();
    this.start = start;
  }

  protected async executeFlow(shared: Shared, params?: Params): Promise<void> {
    let current: BaseNode<Shared, Params> | undefined = this.start.clone();
    const inheritedParams = params ?? this.getParams();

    while (current) {
      current.setParams(inheritedParams);
      const action = await current.run(shared);
      const next = current.getNextNode(action);
      current = next ? next.clone() : undefined;
    }
  }

  public override async run(shared: Shared): Promise<NodeAction> {
    const prepRes = await this.prep(shared);
    await this.executeFlow(shared);
    return await this.post(shared, prepRes, undefined);
  }

  protected override async execute(): Promise<unknown> {
    throw new Error("Flow can't exec.");
  }
}

/**
 * Execute the same flow for a list of parameter overrides provided by prep().
 */
export class BatchFlow<
  Shared = unknown,
  Params extends NonIterableObject = NonIterableObject,
  BatchParams extends NonIterableObject[] = NonIterableObject[],
> extends Flow<Shared, Params> {
  public override async run(shared: Shared): Promise<NodeAction> {
    const batchParams = (await this.prep(shared)) as BatchParams;

    for (const overrides of batchParams) {
      const merged = { ...this.getParams(), ...overrides } as Params;
      await this.executeFlow(shared, merged);
    }

    return await this.post(shared, batchParams, undefined);
  }

  protected override async exec(): Promise<unknown> {
    throw new Error("BatchFlow can't exec.");
  }

  protected override async post(
    shared: Shared,
    prepRes: unknown,
    execRes: unknown,
  ): Promise<NodeAction> {
    return undefined;
  }
}

/**
 * Run batch flow executions in parallel. Each batch entry is executed with its
 * own parameter overrides.
 */
export class ParallelBatchFlow<
  Shared = unknown,
  Params extends NonIterableObject = NonIterableObject,
  BatchParams extends NonIterableObject[] = NonIterableObject[],
> extends BatchFlow<Shared, Params, BatchParams> {
  public override async run(shared: Shared): Promise<NodeAction> {
    const batchParams = (await this.prep(shared)) as BatchParams;

    await Promise.all(
      batchParams.map(async (overrides) => {
        const merged = { ...this.getParams(), ...overrides } as Params;
        await this.executeFlow(shared, merged);
      }),
    );

    return await this.post(shared, batchParams, undefined);
  }
}

export default BaseNode;
