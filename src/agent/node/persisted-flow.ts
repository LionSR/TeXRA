// Code from https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts

import { BaseNode, Flow } from './index';

export interface KVStore {
  read<T = any>(key: string): Promise<T | undefined>;
  write(key: string, value: any): Promise<void>;
  delete?(key: string): Promise<void>;
  listKeys?(prefix?: string): Promise<string[]>;
}

type Action = string;

interface NodeRecord {
  action?: string;
}

interface FlowRecord {
  flowName: string;
  params: Record<string, unknown>;
  shared: Record<string, unknown>;
  createdAt: string;
  nodes: NodeRecord[];
}

/**
 * A Flow that persists its execution state to a KVStore after each node.
 *
 * This enables:
 * - Resume from any node on crash/restart
 * - Distributed execution (different processes can resume)
 * - Execution audit trail via node history
 *
 * Key design principles:
 * - Only shared state is persisted (not services - they're runtime dependencies)
 * - Node history tracks actions, not outputs (minimal storage)
 * - Resume replays by navigating the graph, not re-executing nodes
 *
 * @template S - Shared state type (must be serializable)
 * @template P - Params type (must be serializable)
 * @template Svc - Services type (NOT serialized - injected at runtime)
 */
export class PersistedFlow<
  S extends Record<string, unknown> = Record<string, unknown>,
  P extends Record<string, unknown> = Record<string, unknown>,
  Svc = unknown,
> extends Flow<S, P, Svc> {
  private readonly runId: string;
  private readonly kv: KVStore;

  constructor(start: BaseNode<any, any>, kv: KVStore, runId?: string) {
    super(start);
    this.kv = kv;
    this.runId = runId ?? crypto.randomUUID();
  }

  async run(shared: S): Promise<Action | undefined> {
    await this.ensureRecord(shared);
    while (await this.step()) {
      // Do nothing
    }
    const flow = await this.kv.read<FlowRecord>(`flow:${this.runId}`);
    return flow?.nodes.at(-1)?.action as Action | undefined;
  }

  async step(): Promise<boolean> {
    const key = `flow:${this.runId}`;
    const flow = (await this.kv.read<FlowRecord>(key))!;

    // Validate flow record structure
    if (!flow || !Array.isArray(flow.nodes)) {
      throw new Error('Invalid or corrupted flow record');
    }

    let cursor: BaseNode<any, any> | undefined = this.start;
    for (const n of flow.nodes)
      cursor = cursor?.getNextNode(n.action as Action);
    if (!cursor) return false;

    const params = flow.params as P;
    const shared = flow.shared as S;

    if (!shared) {
      throw new Error('Missing shared state in flow record');
    }

    let action: Action | undefined;

    try {
      cursor.setParams(params as any);
      // Propagate services to node (services are runtime dependencies, not persisted)
      cursor.setServices(this._services);
      action = await cursor._run(shared);
    } catch (e) {
      // Don't write anything when node execution fails
      // Let the upper layer handle retries or error recovery
      throw e;
    }

    flow.nodes.push({ action });
    flow.shared = shared;
    await this.kv.write(key, flow);
    return true;
  }

  static async attach<
    S extends Record<string, unknown>,
    P extends Record<string, unknown> = Record<string, unknown>,
    Svc = unknown,
  >(
    kv: KVStore,
    runId: string,
    start: BaseNode<any, any>,
  ): Promise<PersistedFlow<S, P, Svc>> {
    const flow = await kv.read<FlowRecord>(`flow:${runId}`);
    if (!flow) throw new Error(`flow "${runId}" not found`);
    const pf = new PersistedFlow<S, P, Svc>(start, kv, runId);
    pf.setParams(flow.params as P);
    return pf;
  }

  async getShared(): Promise<S | undefined> {
    const flow = await this.kv.read<FlowRecord>(`flow:${this.runId}`);
    return flow?.shared as S | undefined;
  }

  async setShared(newShared: S): Promise<void> {
    const key = `flow:${this.runId}`;
    const flow = (await this.kv.read<FlowRecord>(key))!;
    flow.shared = structuredClone(newShared);
    await this.kv.write(key, flow);
  }

  getRunId(): string {
    return this.runId;
  }

  async init(shared: S): Promise<void> {
    await this.ensureRecord(shared);
  }

  private async ensureRecord(shared: S): Promise<void> {
    const key = `flow:${this.runId}`;
    const exists = await this.kv.read(key);
    if (exists) return;

    const record: FlowRecord = {
      flowName: 'texra',
      params: this._params as Record<string, unknown>,
      shared: structuredClone(shared),
      createdAt: new Date().toISOString(),
      nodes: [],
    };
    await this.kv.write(key, record);
  }
}
