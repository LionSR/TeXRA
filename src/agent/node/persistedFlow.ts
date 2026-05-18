// Based on https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts
// Enhanced to use ExecutionKVStore as first-citizen interface

import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';

import * as logger from '@agent/core/logger';
import { toErrorMessage } from '@common/errors';

import { BaseNode, Flow, type Action } from '.';

/** KV key for a flow record. Single source of truth for the prefix. */
export function flowKey(runId: string): string {
  return `flow_${runId}`;
}

const CHANNEL = 'PersistedFlow';
logger.initialize(CHANNEL);

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
export class PersistedFlow<
  S = Record<string, unknown>,
  P extends Record<string, unknown> = Record<string, unknown>,
  Svc = unknown,
> extends Flow<S, P, Svc> {
  protected readonly runId: string;
  protected readonly kv: ExecutionKVStore;

  /**
   * In-memory cache of the flow record.
   *
   * Since a PersistedFlow instance is the sole owner/mutator of its record,
   * we can serve reads from cache after the first KVStore read or any write.
   * This eliminates one filesystem read per node execution (the read in
   * stepWithResult that immediately follows the previous step's write).
   */
  private cachedRecord: FlowRecord | null = null;

  /**
   * Optional write-through projection callback.
   *
   * Called (and awaited) after every persist (stepWithResult, setShared,
   * resetNodeHistory) so derived views (todos, conversation) stay current.
   * Errors are swallowed — the authoritative flow blob is already written.
   */
  private projection:
    | ((shared: S, kv: ExecutionKVStore) => Promise<void>)
    | null = null;

  /**
   * Create a new PersistedFlow.
   *
   * @param start - The starting node of the flow graph
   * @param kv - Storage backend (ExecutionKVStore)
   * @param runId - Optional run identifier. Defaults to kv.getExecutionId().
   */
  constructor(start: BaseNode<any, any>, kv: ExecutionKVStore, runId?: string) {
    super(start);
    this.kv = kv;
    this.runId = runId ?? kv.getExecutionId();
  }

  /** Register a write-through projection that fires after each persist. */
  setProjection(fn: (shared: S, kv: ExecutionKVStore) => Promise<void>): void {
    this.projection = fn;
  }

  /** Run projection best-effort (errors are swallowed and warned). */
  private async fireProjection(shared: S): Promise<void> {
    if (!this.projection) return;
    try {
      await this.projection(shared, this.kv);
    } catch (err) {
      logger.warn(CHANNEL, `Projection failed: ${toErrorMessage(err)}`, {
        data: err,
      });
    }
  }

  /**
   * Deep clone shared state for storage.
   * Shared state should be serializable (no class instances, functions, or symbols).
   */
  protected serializeShared(shared: S): Record<string, unknown> {
    return structuredClone(shared) as Record<string, unknown>;
  }

  async run(shared: S): Promise<Action | undefined> {
    await this.ensureRecord(shared);
    while (await this.step()) {
      // step loop
    }
    return this.cachedRecord?.nodes.at(-1)?.action as Action | undefined;
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
    const key = flowKey(this.runId);
    const flow = this.cachedRecord ?? (await this.kv.read<FlowRecord>(key));

    if (!flow || !Array.isArray(flow.nodes)) {
      throw new Error('Invalid or corrupted flow record');
    }

    let cursor: BaseNode<any, any> | undefined = this.start;
    for (const n of flow.nodes)
      cursor = cursor?.getNextNode(n.action as Action);

    // No more nodes to execute
    if (!cursor) {
      this.cachedRecord = flow;
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

    // Invalidate cache before mutation: if kv.write fails, the next read
    // falls through to KVStore which has the correct pre-mutation state.
    this.cachedRecord = null;
    flow.nodes.push({ action });
    flow.shared = this.serializeShared(shared);
    await this.kv.write(key, flow);
    this.cachedRecord = flow;
    await this.fireProjection(shared);

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
    S = Record<string, unknown>,
    P extends Record<string, unknown> = Record<string, unknown>,
    Svc = unknown,
  >(
    kv: ExecutionKVStore,
    runId: string | undefined,
    start: BaseNode<any, any>,
  ): Promise<PersistedFlow<S, P, Svc>> {
    const effectiveRunId = runId ?? kv.getExecutionId();
    const flow = await kv.read<FlowRecord>(flowKey(effectiveRunId));
    if (!flow) throw new Error(`flow "${effectiveRunId}" not found`);
    const pf = new PersistedFlow<S, P, Svc>(start, kv, effectiveRunId);
    pf.setParams(flow.params as P);
    pf.cachedRecord = flow;
    return pf;
  }

  async getShared(): Promise<S | undefined> {
    const flow =
      this.cachedRecord ??
      (await this.kv.read<FlowRecord>(flowKey(this.runId)));
    if (flow) this.cachedRecord = flow;
    return flow?.shared as S | undefined;
  }

  async setShared(newShared: S): Promise<void> {
    const key = flowKey(this.runId);
    const flow = this.cachedRecord ?? (await this.kv.read<FlowRecord>(key))!;
    this.cachedRecord = null;
    flow.shared = this.serializeShared(newShared);
    await this.kv.write(key, flow);
    this.cachedRecord = flow;
    await this.fireProjection(newShared);
  }

  getRunId(): string {
    return this.runId;
  }

  /**
   * Reset the node history so the next stepWithResult() starts from the
   * beginning of the flow graph. Used by RoundPersistedFlow to loop rounds
   * without embedding loop edges in the graph itself.
   */
  protected async resetNodeHistory(shared: S): Promise<void> {
    const key = flowKey(this.runId);
    const flow = this.cachedRecord ?? (await this.kv.read<FlowRecord>(key))!;
    this.cachedRecord = null;
    flow.nodes = [];
    flow.shared = this.serializeShared(shared);
    await this.kv.write(key, flow);
    this.cachedRecord = flow;
    await this.fireProjection(shared);
  }

  async init(shared: S): Promise<void> {
    await this.ensureRecord(shared);
  }

  private async ensureRecord(shared: S): Promise<void> {
    const key = flowKey(this.runId);
    const existing = await this.kv.read<FlowRecord>(key);
    if (existing) {
      this.cachedRecord = existing;
      return;
    }

    const record: FlowRecord = {
      flowName: 'texra',
      params: this._params as Record<string, unknown>,
      shared: this.serializeShared(shared),
      createdAt: new Date().toISOString(),
      nodes: [],
    };
    await this.kv.write(key, record);
    this.cachedRecord = record;
  }
}
