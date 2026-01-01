// Based on https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts
// Enhanced to use ExecutionKVStore as first-citizen interface

import type { ExecutionKVStore } from '@agent/storage';

import { BaseNode, Flow } from './index';

/**
 * Legacy KVStore interface for backward compatibility.
 * Prefer ExecutionKVStore for new code.
 * @deprecated Use ExecutionKVStore instead
 */
export interface KVStore {
  read<T = unknown>(key: string): Promise<T | undefined>;
  write(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<void>;
  listKeys?(prefix?: string): Promise<string[]>;
}

/**
 * Union type that accepts either legacy KVStore or new ExecutionKVStore.
 * This allows gradual migration to ExecutionKVStore.
 */
export type FlowStore = KVStore | ExecutionKVStore;

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

// ============================================================================
// Serialization Hooks
// ============================================================================

/**
 * Serialized state type - must be structuredClone-safe (plain JSON).
 */
export type SerializedState = Record<string, unknown>;

/**
 * Hooks for custom serialization/deserialization of shared state.
 *
 * Use when shared state contains class instances that can't survive structuredClone:
 * - AgentWorkspaceState → workspaceSnapshot
 * - AgentRunState → runStateSnapshot
 * - ConversationRoundState → roundStateSnapshot
 *
 * @example
 * ```typescript
 * const serialization: SerializationHooks<MyState> = {
 *   serialize: (shared) => ({
 *     ...shared,
 *     workspace: shared.workspace.toSnapshot(),
 *   }),
 *   deserialize: (data) => ({
 *     ...data,
 *     workspace: AgentWorkspaceState.fromSnapshot(data.workspace),
 *   }),
 * };
 * ```
 */
export interface SerializationHooks<S> {
  /**
   * Convert shared state to a structuredClone-safe format for storage.
   * Called before writing to KV store.
   *
   * @param shared - The live shared state (may contain class instances)
   * @returns Plain JSON object safe for structuredClone
   */
  serialize: (shared: S) => SerializedState;

  /**
   * Reconstruct shared state from serialized format after reading from storage.
   * Called after reading from KV store.
   *
   * @param data - Plain JSON object from storage
   * @returns Reconstructed shared state (with class instances restored)
   */
  deserialize: (data: SerializedState) => S;
}

/**
 * Configuration for PersistedFlow.
 */
export interface PersistedFlowConfig<S> {
  /**
   * Custom serialization hooks for shared state.
   * If not provided, uses structuredClone (requires plain JSON state).
   */
  serialization?: SerializationHooks<S>;
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
  protected readonly serialization?: SerializationHooks<S>;

  /**
   * Create a new PersistedFlow.
   *
   * @param start - The starting node of the flow graph
   * @param kv - Storage backend (ExecutionKVStore preferred, KVStore for legacy)
   * @param runId - Optional run identifier. If using ExecutionKVStore, defaults to executionId.
   *                Otherwise generates a new UUID.
   * @param config - Optional configuration including serialization hooks.
   */
  constructor(
    start: BaseNode<any, any>,
    kv: FlowStore,
    runId?: string,
    config?: PersistedFlowConfig<S>,
  ) {
    super(start);
    this.kv = kv;
    this.serialization = config?.serialization;
    // Prefer executionId from ExecutionKVStore if available
    this.runId =
      runId ??
      ('getExecutionId' in kv ? kv.getExecutionId() : crypto.randomUUID());
  }

  /**
   * Serialize shared state for storage.
   * Uses custom hooks if provided, otherwise structuredClone.
   */
  protected serializeShared(shared: S): SerializedState {
    if (this.serialization) {
      return this.serialization.serialize(shared);
    }
    return structuredClone(shared);
  }

  /**
   * Deserialize shared state from storage.
   * Uses custom hooks if provided, otherwise returns as-is (already cloned by storage).
   */
  protected deserializeShared(data: SerializedState): S {
    if (this.serialization) {
      return this.serialization.deserialize(data);
    }
    return data as S;
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
        shared: this.deserializeShared(flow.shared),
      };
    }

    const params = flow.params as P;
    const shared = this.deserializeShared(flow.shared);

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
   * @param kv - Storage backend (ExecutionKVStore preferred)
   * @param runId - The run identifier to resume. For ExecutionKVStore, can be omitted to use executionId.
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
    // Use executionId from ExecutionKVStore if runId not provided
    const effectiveRunId =
      runId ?? ('getExecutionId' in kv ? kv.getExecutionId() : undefined);
    if (!effectiveRunId) {
      throw new Error('runId is required when not using ExecutionKVStore');
    }
    const flow = await kv.read<FlowRecord>(`flow:${effectiveRunId}`);
    if (!flow) throw new Error(`flow "${effectiveRunId}" not found`);
    const pf = new PersistedFlow<S, P, Svc>(start, kv, effectiveRunId);
    pf.setParams(flow.params as P);
    return pf;
  }

  async getShared(): Promise<S | undefined> {
    const flow = await this.kv.read<FlowRecord>(`flow:${this.runId}`);
    return flow?.shared ? this.deserializeShared(flow.shared) : undefined;
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
