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
 * @template S - Shared state type (must be serializable via structuredClone)
 * @template P - Params type (must be serializable)
 * @template Svc - Services type (NOT serialized - injected at runtime)
 */
export class PersistedFlow<
  S = Record<string, unknown>,
  P extends Record<string, unknown> = Record<string, unknown>,
  Svc = unknown,
> extends Flow<S, P, Svc> {
  protected readonly runId: string;
  protected readonly kv: ExecutionKVStore;
  /**
   * Whether to persist shared state to KV store after every node execution.
   * When false, state is persisted only on explicit `setShared()` calls.
   */
  protected readonly persistEveryStep: boolean;
  /** In-memory flow record — avoids redundant KV reads within a run. */
  private _record: FlowRecord | undefined;

  constructor(
    start: BaseNode<any, any>,
    kv: ExecutionKVStore,
    runId?: string,
    persistEveryStep = true,
  ) {
    super(start);
    this.kv = kv;
    this.runId = runId ?? kv.getExecutionId();
    this.persistEveryStep = persistEveryStep;
  }

  protected serializeShared(shared: S): Record<string, unknown> {
    return structuredClone(shared) as Record<string, unknown>;
  }

  /** Load the flow record, returning the cached copy if available. */
  private async loadRecord(): Promise<FlowRecord | undefined> {
    return (this._record ??= await this.kv.read<FlowRecord>(
      `flow:${this.runId}`,
    ));
  }

  async run(shared: S): Promise<Action | undefined> {
    await this.ensureRecord(shared);
    let result = await this.stepWithResult();
    while (result.hasMore) {
      result = await this.stepWithResult();
    }
    return result.action as Action | undefined;
  }

  /**
   * Execute a single step and return full result including action and shared state.
   */
  protected async stepWithResult(): Promise<StepResult<S>> {
    const flow = await this.loadRecord();

    if (!flow || !Array.isArray(flow.nodes)) {
      throw new Error('Invalid or corrupted flow record');
    }

    let cursor: BaseNode<any, any> | undefined = this.start;
    for (const n of flow.nodes)
      cursor = cursor?.getNextNode(n.action as Action);

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
      await this.kv.write(`flow:${this.runId}`, flow);
    }

    return {
      hasMore: true,
      action,
      shared,
    };
  }

  async getShared(): Promise<S | undefined> {
    const flow = await this.loadRecord();
    return flow?.shared as S | undefined;
  }

  async setShared(newShared: S): Promise<void> {
    const flow = (await this.loadRecord())!;
    flow.shared = this.serializeShared(newShared);
    this._record = flow;
    await this.kv.write(`flow:${this.runId}`, flow);
  }

  protected async ensureRecord(shared: S): Promise<void> {
    const existing = await this.loadRecord();
    if (existing) return;

    const record: FlowRecord = {
      flowName: 'texra',
      params: this._params as Record<string, unknown>,
      shared: this.serializeShared(shared),
      createdAt: new Date().toISOString(),
      nodes: [],
    };
    this._record = record;
    await this.kv.write(`flow:${this.runId}`, record);
  }
}
