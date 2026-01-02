// Based on https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts
// Enhanced to use ExecutionKVStore as first-citizen interface

import type { ExecutionKVStore } from '@agent/storage';

import { BaseNode, Flow } from './index';

/**
 * Storage backend for persisted flows.
 * Alias for ExecutionKVStore - the standard storage interface.
 */
export type FlowStore = ExecutionKVStore;

type Action = string;

interface NodeRecord {
  action?: string;
}

export interface FlowRecord {
  flowName: string;
  params: Record<string, unknown>;
  shared: Record<string, unknown>;
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
 * @template S - Shared state type (must be serializable)
 * @template P - Params type (must be serializable)
 * @template Svc - Services type (NOT serialized - injected at runtime)
 */
export class PersistedFlow<
  S extends Record<string, unknown> = Record<string, unknown>,
  P extends Record<string, unknown> = Record<string, unknown>,
  Svc = unknown,
> extends Flow<S, P, Svc> {
  protected readonly runId: string;
  protected readonly kv: FlowStore;

  /**
   * Create a new PersistedFlow.
   *
   * @param start - The starting node of the flow graph
   * @param kv - Storage backend (ExecutionKVStore)
   * @param runId - Optional run identifier. Defaults to kv.getExecutionId().
   */
  constructor(start: BaseNode<any, any>, kv: FlowStore, runId?: string) {
    super(start);
    this.kv = kv;
    this.runId = runId ?? kv.getExecutionId();
  }

  /**
   * Serialize shared state for storage using structuredClone.
   * Shared state must be plain JSON (no class instances).
   */
  protected serializeShared(shared: S): Record<string, unknown> {
    return structuredClone(shared);
  }

  async run(shared: S): Promise<Action | undefined> {
    await this.ensureRecord(shared);
    while (await this.step()) {
      // Do nothing
    }
    const flow = await this.kv.read<FlowRecord>(`flow:${this.runId}`);
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
    const flow = (await this.kv.read<FlowRecord>(key))!;

    // Validate flow record structure
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
    flow.shared = this.serializeShared(shared);
    await this.kv.write(key, flow);

    return {
      hasMore: true,
      action,
      shared,
    };
  }

  /**
   * Attach to an existing persisted flow for resume.
   *
   * @param kv - Storage backend (ExecutionKVStore)
   * @param runId - The run identifier to resume. Defaults to kv.getExecutionId().
   * @param start - The starting node of the flow graph
   */
  static async attach<
    S extends Record<string, unknown>,
    P extends Record<string, unknown> = Record<string, unknown>,
    Svc = unknown,
  >(
    kv: FlowStore,
    runId: string | undefined,
    start: BaseNode<any, any>,
  ): Promise<PersistedFlow<S, P, Svc>> {
    const effectiveRunId = runId ?? kv.getExecutionId();
    const flow = await kv.read<FlowRecord>(`flow:${effectiveRunId}`);
    if (!flow) throw new Error(`flow "${effectiveRunId}" not found`);
    const pf = new PersistedFlow<S, P, Svc>(start, kv, effectiveRunId);
    pf.setParams(flow.params as P);
    return pf;
  }

  async getShared(): Promise<S | undefined> {
    const flow = await this.kv.read<FlowRecord>(`flow:${this.runId}`);
    return (flow?.shared as S) ?? undefined;
  }

  async setShared(newShared: S): Promise<void> {
    const key = `flow:${this.runId}`;
    const flow = (await this.kv.read<FlowRecord>(key))!;
    flow.shared = this.serializeShared(newShared);
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
      shared: this.serializeShared(shared),
      createdAt: new Date().toISOString(),
      nodes: [],
    };
    await this.kv.write(key, record);
  }
}
