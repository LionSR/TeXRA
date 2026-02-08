// Based on https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts
// Enhanced to use ExecutionKVStore as first-citizen interface

import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';

import { BaseNode, Flow, type Action } from '.';

interface NodeRecord {
  action?: string;
}

export interface FlowRecord {
  flowName: string;
  params: Record<string, unknown>;
  shared: unknown;
  createdAt: string;
  nodes: NodeRecord[];
}

/**
 * Result from a step execution.
 * Used by stepWithResult() for subclasses that need action and shared state.
 */
export interface StepResult<S> {
  /** Whether there are more nodes to execute */
  hasMore: boolean;
  /** The action returned by the node (for routing) */
  action: string | undefined;
  /** The shared state after node execution (mutated in-place) */
  shared: S;
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
 * @template S - Shared state type (must be serializable via structuredClone)
 * @template P - Params type (must be serializable)
 * @template Svc - Services type (NOT serialized - injected at runtime)
 */
export interface PersistedFlowOptions {
  /**
   * Whether to persist shared state to KV store after every node execution.
   * When false, only the node action history is tracked in memory and state
   * is persisted on explicit `setShared()` calls (e.g., at round boundaries).
   * Default: true (backward compatible — persists after every step).
   */
  persistEveryStep?: boolean;
}

export class PersistedFlow<
  S = Record<string, unknown>,
  P extends Record<string, unknown> = Record<string, unknown>,
  Svc = unknown,
> extends Flow<S, P, Svc> {
  protected readonly runId: string;
  protected readonly kv: ExecutionKVStore;
  protected readonly persistEveryStep: boolean;
  /** In-memory cache of the flow record when persistEveryStep is false. */
  private _cachedRecord: FlowRecord | undefined;

  /**
   * Create a new PersistedFlow.
   *
   * @param start - The starting node of the flow graph
   * @param kv - Storage backend (ExecutionKVStore)
   * @param runId - Optional run identifier. Defaults to kv.getExecutionId().
   * @param options - Optional configuration
   */
  constructor(
    start: BaseNode<any, any>,
    kv: ExecutionKVStore,
    runId?: string,
    options?: PersistedFlowOptions,
  ) {
    super(start);
    this.kv = kv;
    this.runId = runId ?? kv.getExecutionId();
    this.persistEveryStep = options?.persistEveryStep ?? true;
  }

  /**
   * Deep clone shared state for storage.
   * Shared state should be serializable (no class instances, functions, or symbols).
   */
  protected serializeShared(shared: S): Record<string, unknown> {
    return structuredClone(shared) as Record<string, unknown>;
  }

  /**
   * Read the flow record, using the in-memory cache when persistEveryStep is false.
   */
  private async readFlowRecord(key: string): Promise<FlowRecord | undefined> {
    if (!this.persistEveryStep && this._cachedRecord) {
      return this._cachedRecord;
    }
    const record = await this.kv.read<FlowRecord>(key);
    if (!this.persistEveryStep && record) {
      this._cachedRecord = record;
    }
    return record;
  }

  /**
   * Write the flow record to KV store and update the cache.
   */
  private async writeFlowRecord(
    key: string,
    record: FlowRecord,
  ): Promise<void> {
    this._cachedRecord = record;
    await this.kv.write(key, record);
  }

  async run(shared: S): Promise<Action | undefined> {
    await this.ensureRecord(shared);
    while (await this.step()) {
      // Do nothing
    }
    const key = `flow:${this.runId}`;
    const flow = await this.readFlowRecord(key);
    return flow?.nodes.at(-1)?.action as Action | undefined;
  }

  /**
   * Execute a single step (one node).
   * Returns true if there are more nodes to execute.
   */
  async step(): Promise<boolean> {
    const result = await this.stepWithResult();
    return result.hasMore;
  }

  /**
   * Execute a single step and return full result including action and shared state.
   *
   * This is the preferred method for subclasses that need to:
   * - Inspect the action returned by the node (for routing decisions)
   * - Access the mutated shared state without re-reading from storage
   *
   * The returned shared reference is the same object that was mutated by the node,
   * so callers can use it directly without Object.assign.
   */
  protected async stepWithResult(): Promise<StepResult<S>> {
    const key = `flow:${this.runId}`;
    const flow = await this.readFlowRecord(key);

    if (!flow || !Array.isArray(flow.nodes)) {
      throw new Error('Invalid or corrupted flow record');
    }

    let cursor: BaseNode<any, any> | undefined = this.start;
    for (const n of flow.nodes)
      cursor = cursor?.getNextNode(n.action as Action);

    // No more nodes to execute
    if (!cursor) {
      return {
        hasMore: false,
        action: flow.nodes.at(-1)?.action,
        shared: flow.shared as S,
      };
    }

    const params = flow.params as P;
    const shared = flow.shared as S;

    if (!shared) {
      throw new Error('Missing shared state in flow record');
    }

    cursor.setParams(params);
    cursor.setServices(this._services);
    const action = await cursor._run(shared);

    flow.nodes.push({ action });
    if (this.persistEveryStep) {
      flow.shared = this.serializeShared(shared);
      await this.writeFlowRecord(key, flow);
    }

    return {
      hasMore: true,
      action,
      shared,
    };
  }

  async getShared(): Promise<S | undefined> {
    const key = `flow:${this.runId}`;
    const flow = await this.readFlowRecord(key);
    return flow?.shared as S | undefined;
  }

  async setShared(newShared: S): Promise<void> {
    const key = `flow:${this.runId}`;
    const flow = (await this.readFlowRecord(key))!;
    flow.shared = this.serializeShared(newShared);
    await this.writeFlowRecord(key, flow);
  }

  getRunId(): string {
    return this.runId;
  }

  async init(shared: S): Promise<void> {
    await this.ensureRecord(shared);
  }

  private async ensureRecord(shared: S): Promise<void> {
    const key = `flow:${this.runId}`;
    const exists = await this.readFlowRecord(key);
    if (exists) return;

    const record: FlowRecord = {
      flowName: 'texra',
      params: this._params as Record<string, unknown>,
      shared: this.serializeShared(shared),
      createdAt: new Date().toISOString(),
      nodes: [],
    };
    await this.writeFlowRecord(key, record);
  }
}
