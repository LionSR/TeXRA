// Based on https://github.com/Yuyz0112/koala-code-reader/blob/main/src/code-reader/persisted-flow.ts
// Enhanced to use ExecutionKVStore as first-citizen interface

// Third-party imports
import { z } from 'zod';

// Local imports - agent
import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

// Local imports - utilities
import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - flow engine
import { BaseNode, Flow, type Action } from '.';

/** Prefix for a flow record's KV key. Single source of truth for callers deriving it. */
export const FLOW_KEY_PREFIX = 'flow_';

/** KV key for a flow record. Single source of truth for the prefix. */
export function flowKey(runId: string): string {
  return `${FLOW_KEY_PREFIX}${runId}`;
}

const log = createLog('PersistedFlow');

export const FLOW_RECORD_SCHEMA_VERSION = 2;
const START_NODE_ID = 'start';

interface NodeRecord {
  action?: string;
  nodeId?: string;
}

interface FlowCursor {
  /** The next graph-local node path, or null when the flow has reached a terminal edge. */
  nextNodeId: string | null;
  /** Last action emitted by the previous node; reported as the terminal action on replay. */
  lastAction?: string;
}

export interface FlowRecord {
  schemaVersion?: number;
  flowName: string;
  shared: unknown;
  createdAt: string;
  /**
   * Authoritative replay cursor. `nodes[]` is only an audit log: it can be
   * capped or moved later without changing resume semantics. Every write path
   * stamps a cursor; a record without one is rejected as unsupported.
   */
  cursor: FlowCursor;
  nodes: NodeRecord[];
}

const PersistedFlowNodeRecordSchema = z.looseObject({
  action: z.string().optional(),
  nodeId: z.string().optional(),
});

const PersistedFlowCursorSchema = z.looseObject({
  nextNodeId: z.string().nullable(),
  lastAction: z.string().optional(),
});

const PersistedFlowRecordObjectSchema = z.looseObject({
  schemaVersion: z.int().min(1).max(FLOW_RECORD_SCHEMA_VERSION).optional(),
  flowName: z.string(),
  shared: z.unknown(),
  createdAt: z.string(),
  cursor: PersistedFlowCursorSchema,
  nodes: z.array(PersistedFlowNodeRecordSchema),
});

/**
 * Runtime envelope shared by flow recovery and resume eligibility. The first
 * stage checks the raw input so an inherited or parser-invented `shared` key
 * cannot satisfy the persisted own-property contract.
 */
export const PersistedFlowRecordEnvelopeSchema = z
  .unknown()
  .refine(
    (stored) =>
      typeof stored === 'object' &&
      stored !== null &&
      !Array.isArray(stored) &&
      Object.hasOwn(stored, 'shared'),
    { message: 'Flow record must be an object with an own shared field' },
  )
  .pipe(PersistedFlowRecordObjectSchema);

export type PersistedFlowStateErrorReason =
  | 'read-failed'
  | 'unsupported-record'
  | 'missing-shared'
  | 'invalid-shared'
  | 'unexpected-record';

/** Persisted flow state cannot be read or resumed safely. */
export class PersistedFlowStateError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: PersistedFlowStateErrorReason,
    options?: ErrorOptions,
  ) {
    const message = (() => {
      switch (reason) {
        case 'read-failed':
          return `Failed to read persisted flow state for run "${runId}".`;
        case 'unsupported-record':
          return `Persisted flow state for run "${runId}" has an unsupported record format.`;
        case 'missing-shared':
          return `Persisted flow state for run "${runId}" is missing its shared state.`;
        case 'invalid-shared':
          return `Persisted shared state for flow run "${runId}" is invalid.`;
        case 'unexpected-record':
          return `A persisted flow record exists for run "${runId}", but no resume handoff was provided.`;
      }
    })();
    super(message, options);
    this.name = 'PersistedFlowStateError';
  }
}

/**
 * Read a flow record without conflating a stored unsupported value with an
 * absent key. Flow-specific callers remain responsible for migrating and
 * validating `shared`.
 */
export async function readPersistedFlowRecord(
  kv: ExecutionKVStore,
  runId: string,
): Promise<FlowRecord | null> {
  let stored: unknown;
  try {
    stored = await kv.read<unknown>(flowKey(runId));
  } catch (cause) {
    throw new PersistedFlowStateError(runId, 'read-failed', { cause });
  }

  if (stored === undefined) return null;
  const parsed = PersistedFlowRecordEnvelopeSchema.safeParse(stored);
  if (!parsed.success) {
    const missingShared =
      typeof stored === 'object' &&
      stored !== null &&
      !Array.isArray(stored) &&
      !Object.hasOwn(stored, 'shared');
    throw new PersistedFlowStateError(
      runId,
      missingShared ? 'missing-shared' : 'unsupported-record',
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

export function stampFlowRecordSchemaVersion<T extends FlowRecord>(flow: T): T {
  flow.schemaVersion = FLOW_RECORD_SCHEMA_VERSION;
  return flow;
}

/**
 * Stamps the active handler's compatibility key onto a keyless legacy shared
 * record so {@link PersistedFlow.ensureRecord} never sees a stale legacy
 * shape. Records that already carry a key — or that have no active key to
 * stamp — are returned unchanged (same object identity). Model-based
 * inference for keyless records lives at the resume-retrieval boundary
 * (SessionResumeRetrieval); this path stamps the handler currently in play.
 */
export function stampCompatibilityKey<
  T extends { modelHandlerCompatibilityKey?: string | null },
>(record: T, compatibilityKey: string | undefined): T {
  if (record.modelHandlerCompatibilityKey || !compatibilityKey) return record;
  return { ...record, modelHandlerCompatibilityKey: compatibilityKey };
}

/**
 * Result from a step execution.
 * Used by stepWithResult() for subclasses that need action and shared state.
 */
interface StepResult<S> {
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
 * @template Svc - Services type (NOT serialized - injected at runtime)
 */
export class PersistedFlow<
  S = Record<string, unknown>,
  Svc = unknown,
> extends Flow<S, Svc> {
  protected readonly runId: string;
  protected readonly kv: ExecutionKVStore;

  /**
   * Optional schema for the persisted `shared` blob. When provided, every
   * read of `flow.shared` off the KV store is parsed through it instead of
   * blindly asserted as `S` — a corrupted or stale-schema record then fails
   * loudly at the point of resume rather than propagating a wrongly-shaped
   * object under a trusted type.
   */
  private readonly sharedSchema: z.ZodType<S> | undefined;

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
   * Whether `cachedRecord.shared` is already a validated `S`. Records this
   * instance wrote itself are trusted; only a record deserialized from the
   * KV store is parsed through `sharedSchema` (boundary-only validation), so
   * steps served from the self-cache skip the per-transition re-parse.
   */
  private cachedSharedTrusted = false;
  private nodeIds: Map<BaseNode, string> | null = null;
  private nodesById: Map<string, BaseNode> | null = null;

  /**
   * Optional write-through projection callback.
   *
   * Called (and awaited) after every persist (stepWithResult, setShared,
   * resetNodeHistory) so derived views (todos, conversation) stay current.
   * Errors are swallowed — the authoritative flow blob is already written.
   */
  private projection:
    ((shared: S, kv: ExecutionKVStore) => Promise<void>) | null = null;

  /**
   * Create a new PersistedFlow.
   *
   * @param start - The starting node of the flow graph
   * @param kv - Storage backend (ExecutionKVStore)
   * @param runId - Optional run identifier. Defaults to kv.getExecutionId().
   */
  constructor(
    start: BaseNode,
    kv: ExecutionKVStore,
    runId?: string,
    sharedSchema?: z.ZodType<S>,
  ) {
    super(start);
    this.kv = kv;
    this.runId = runId ?? kv.getExecutionId();
    this.sharedSchema = sharedSchema;
  }

  /** Single canonical cast site for trusting a persisted `shared` blob as `S`. */
  private readShared(flow: FlowRecord): S {
    if (!this.sharedSchema || this.cachedSharedTrusted) {
      return flow.shared as S;
    }
    const result = this.sharedSchema.safeParse(flow.shared);
    if (!result.success) {
      throw new Error(
        `Persisted shared state for flow run "${this.runId}" failed schema validation`,
        { cause: result.error },
      );
    }
    // Keep the normalized value on the record so later reads reuse it.
    flow.shared = result.data;
    this.cachedSharedTrusted = true;
    return result.data;
  }

  /**
   * Read the flow record, serving from this instance's cache when present. A
   * true KV read marks the shared blob untrusted so the next `readShared`
   * re-validates at the deserialization boundary.
   */
  private async loadRecord(): Promise<FlowRecord | undefined> {
    if (this.cachedRecord) return this.cachedRecord;
    const flow = await this.kv.read<FlowRecord>(flowKey(this.runId));
    this.cachedSharedTrusted = false;
    return flow;
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
      log.warn(`Projection failed: ${toErrorMessage(err)}`, {
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
    let step = await this.stepWithResult();
    while (step.hasMore) {
      step = await this.stepWithResult();
    }
    // The loop only exits on a suspension (which always carries an action) or
    // on the terminal step, which already resolves the record's last action.
    return step.action;
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
    const flow = await this.loadRecord();

    if (!flow || !Array.isArray(flow.nodes)) {
      throw new Error('Invalid or corrupted flow record');
    }

    const cursor = this.resolveCursor(flow);

    // No more nodes to execute
    if (!cursor) {
      this.cachedRecord = flow;
      return {
        hasMore: false,
        action: flow.cursor.lastAction,
        shared: this.readShared(flow),
      };
    }

    const shared = this.readShared(flow);

    if (!shared) {
      throw new Error('Missing shared state in flow record');
    }

    cursor.setServices(this._services);
    const action = await cursor._run(shared);
    const waiting = action === FlowTransition.WAITING;
    const next = waiting ? cursor : cursor.getNextNode(action);
    const cursorId = this.idForNode(cursor);
    const nextNodeId = next ? this.idForNode(next) : null;

    // Invalidate cache before mutation: if kv.write fails, the next read
    // falls through to KVStore which has the correct pre-mutation state.
    this.cachedRecord = null;
    flow.nodes.push({ action, nodeId: cursorId });
    flow.cursor = {
      nextNodeId,
      ...(action !== undefined ? { lastAction: action } : {}),
    };
    flow.shared = this.serializeShared(shared);
    await this.kv.write(key, stampFlowRecordSchemaVersion(flow));
    this.cachedRecord = flow;
    this.cachedSharedTrusted = true;
    await this.fireProjection(shared);

    return {
      hasMore: !waiting,
      action,
      shared,
    };
  }

  /**
   * The flow's current shared state. Returns the record's live object rather
   * than a copy; the caller owns reads directly, and mutations become
   * durable only through setShared().
   */
  async getShared(): Promise<S | undefined> {
    const flow = await this.loadRecord();
    if (flow) this.cachedRecord = flow;
    return flow?.shared === undefined ? undefined : this.readShared(flow);
  }

  async setShared(newShared: S): Promise<void> {
    await this.commitShared(newShared);
  }

  /**
   * Reset the node history so the next stepWithResult() starts from the
   * beginning of the flow graph. Used by round-looping subclasses to restart
   * the graph without embedding loop edges in it.
   */
  protected async resetNodeHistory(shared: S): Promise<void> {
    await this.commitShared(shared, (flow) => {
      flow.nodes = [];
      flow.cursor = { nextNodeId: this.idForNode(this.start) };
    });
  }

  private resolveCursor(flow: FlowRecord): BaseNode | undefined {
    if (!flow.cursor) {
      throw new Error(
        `Persisted flow record for run "${this.runId}" has no replay cursor; ` +
          'legacy no-cursor records are no longer resumable',
      );
    }
    if (flow.cursor.nextNodeId === null) return undefined;
    const byId = this.nodeIndex().byId;
    const cursor = byId.get(flow.cursor.nextNodeId);
    if (!cursor) {
      throw new Error(
        `Invalid persisted flow cursor: ${flow.cursor.nextNodeId}`,
      );
    }
    return cursor;
  }

  private idForNode(node: BaseNode): string {
    const id = this.nodeIndex().ids.get(node);
    if (!id) {
      throw new Error('Persisted flow graph contains an unindexed node');
    }
    return id;
  }

  private nodeIndex(): {
    readonly ids: Map<BaseNode, string>;
    readonly byId: Map<string, BaseNode>;
  } {
    if (this.nodeIds && this.nodesById) {
      return { ids: this.nodeIds, byId: this.nodesById };
    }

    const ids = new Map<BaseNode, string>();
    const byId = new Map<string, BaseNode>();
    const queue: Array<{ node: BaseNode; id: string }> = [
      { node: this.start, id: START_NODE_ID },
    ];

    for (let index = 0; index < queue.length; index += 1) {
      const { node, id } = queue[index]!;
      if (ids.has(node)) continue;

      ids.set(node, id);
      byId.set(id, node);
      for (const [action, successor] of node
        .successorEntries()
        .toSorted(([left], [right]) => left.localeCompare(right))) {
        if (!ids.has(successor)) {
          queue.push({
            node: successor,
            id: `${id}/${encodeURIComponent(action)}`,
          });
        }
      }
    }

    this.nodeIds = ids;
    this.nodesById = byId;
    return { ids, byId };
  }

  /**
   * Persist new shared state (with an optional record mutation), keeping the
   * in-memory cache consistent. The cache is invalidated before the write so a
   * failed write falls back to the authoritative KVStore state on the next read.
   */
  private async commitShared(
    shared: S,
    mutate?: (flow: FlowRecord) => void,
  ): Promise<void> {
    const key = flowKey(this.runId);
    const flow = await this.loadRecord();
    if (!flow) {
      throw new Error('Invalid or corrupted flow record');
    }
    this.cachedRecord = null;
    mutate?.(flow);
    flow.shared = this.serializeShared(shared);
    await this.kv.write(key, stampFlowRecordSchemaVersion(flow));
    this.cachedRecord = flow;
    this.cachedSharedTrusted = true;
    await this.fireProjection(shared);
  }

  protected async ensureRecord(shared: S): Promise<void> {
    const existing = await this.loadRecord();
    if (existing) {
      this.cachedRecord = existing;
      return;
    }

    const record: FlowRecord = {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      flowName: 'texra',
      shared: this.serializeShared(shared),
      createdAt: new Date().toISOString(),
      cursor: { nextNodeId: this.idForNode(this.start) },
      nodes: [],
    };
    await this.kv.write(flowKey(this.runId), record);
    this.cachedRecord = record;
    this.cachedSharedTrusted = true;
  }
}
