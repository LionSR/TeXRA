export type NodeParams = Record<string, unknown>;
export type NodeAction = string;

export const DEFAULT_NODE_ACTION: NodeAction = 'default';
export const STOP_ACTION: NodeAction = 'stop';

export abstract class BaseNode<
  Shared = unknown,
  Params extends NodeParams = NodeParams,
  PrepResult = unknown,
  ExecResult = unknown,
> {
  protected params: Params;
  protected successors: Map<NodeAction, BaseNode<Shared, Params>>;

  constructor() {
    this.params = {} as Params;
    this.successors = new Map();
  }

  public setParams(params: Params): this {
    this.params = params;
    return this;
  }

  public getParams(): Params {
    return this.params;
  }

  public next<T extends BaseNode<Shared, Params>>(node: T): T {
    this.on(DEFAULT_NODE_ACTION, node);
    return node;
  }

  public on(action: NodeAction, node: BaseNode<Shared, Params>): this {
    this.successors.set(action, node);
    return this;
  }

  public getNextNode(
    action: NodeAction = DEFAULT_NODE_ACTION,
  ): BaseNode<Shared, Params> | undefined {
    return this.successors.get(action);
  }

  public clone(): this {
    const clone = Object.create(Object.getPrototypeOf(this)) as this;
    clone.params = { ...this.params };
    clone.successors = new Map(this.successors);
    return clone;
  }

  protected async prep(shared: Shared): Promise<PrepResult> {
    return undefined as unknown as PrepResult;
  }

  protected async exec(prepResult: PrepResult): Promise<ExecResult> {
    return undefined as unknown as ExecResult;
  }

  protected async post(
    shared: Shared,
    prepResult: PrepResult,
    execResult: ExecResult,
  ): Promise<NodeAction | void> {
    return undefined;
  }

  public async run(shared: Shared): Promise<NodeAction> {
    const prepResult = await this.prep(shared);
    const execResult = await this.exec(prepResult);
    const action = await this.post(shared, prepResult, execResult);
    return action ?? DEFAULT_NODE_ACTION;
  }
}

export abstract class BatchNode<
  Shared = unknown,
  Params extends NodeParams = NodeParams,
  Item = unknown,
  ItemResult = unknown,
> extends BaseNode<Shared, Params, Item[], ItemResult[]> {
  protected abstract runItem(item: Item): Promise<ItemResult> | ItemResult;

  protected override async exec(items: Item[]): Promise<ItemResult[]> {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const results: ItemResult[] = [];
    for (const item of items) {
      results.push(await this.runItem(item));
    }
    return results;
  }
}

export abstract class ParallelBatchNode<
  Shared = unknown,
  Params extends NodeParams = NodeParams,
  Item = unknown,
  ItemResult = unknown,
> extends BatchNode<Shared, Params, Item, ItemResult> {
  protected override async exec(items: Item[]): Promise<ItemResult[]> {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    return Promise.all(items.map((item) => this.runItem(item)));
  }
}

export class Flow<
  Shared = unknown,
  Params extends NodeParams = NodeParams,
  PrepResult = unknown,
> extends BaseNode<Shared, Params, PrepResult, void> {
  private readonly start: BaseNode<Shared, Params>;

  constructor(start: BaseNode<Shared, Params>) {
    super();
    this.start = start;
  }

  private async execute(shared: Shared, params: Params): Promise<void> {
    let current: BaseNode<Shared, Params> | undefined = this.start.clone();

    while (current) {
      current.setParams(params);
      const action = await current.run(shared);
      if (action === STOP_ACTION) {
        break;
      }

      const successor = current.getNextNode(action);
      current = successor?.clone();
    }
  }

  protected async runWithParams(shared: Shared, params: Params): Promise<void> {
    await this.execute(shared, params);
  }

  public override async run(shared: Shared): Promise<NodeAction> {
    const prepResult = await this.prep(shared);
    const params = { ...this.params } as Params;
    await this.runWithParams(shared, params);
    const action = await this.post(
      shared,
      prepResult,
      undefined as unknown as void,
    );
    return action ?? DEFAULT_NODE_ACTION;
  }
}

export class BatchFlow<
  Shared = unknown,
  Params extends NodeParams = NodeParams,
  BatchParams extends NodeParams = Params,
> extends Flow<Shared, Params, BatchParams[]> {
  public override async run(shared: Shared): Promise<NodeAction> {
    const batchParams = await this.prep(shared);
    for (const patch of batchParams) {
      const merged = { ...this.getParams(), ...patch } as Params;
      await this.runWithParams(shared, merged);
    }
    const action = await this.post(
      shared,
      batchParams,
      undefined as unknown as void,
    );
    return action ?? DEFAULT_NODE_ACTION;
  }

  protected override async prep(shared: Shared): Promise<BatchParams[]> {
    return [];
  }
}

export class ParallelBatchFlow<
  Shared = unknown,
  Params extends NodeParams = NodeParams,
  BatchParams extends NodeParams = Params,
> extends BatchFlow<Shared, Params, BatchParams> {
  public override async run(shared: Shared): Promise<NodeAction> {
    const batchParams = await this.prep(shared);
    await Promise.all(
      batchParams.map((patch) => {
        const merged = { ...this.getParams(), ...patch } as Params;
        return this.runWithParams(shared, merged);
      }),
    );
    const action = await this.post(
      shared,
      batchParams,
      undefined as unknown as void,
    );
    return action ?? DEFAULT_NODE_ACTION;
  }
}
