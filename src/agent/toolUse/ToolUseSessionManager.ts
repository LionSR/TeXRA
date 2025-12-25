/**
 * Tool-use session snapshot management.
 *
 * Provides:
 * - Zod schema and types for session snapshots (single source of truth)
 * - In-memory cache for lazy resume when user returns to a session
 * - Dual indexing by stream ID and execution ID for efficient lookup
 *
 * @see ToolUseSessionPersistence for disk persistence orchestration
 * @see ToolUseSnapshotStore for the persistent storage layer
 */

// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { AgentSharedStoreSnapshotSchema } from '@agent/core/AgentSharedStore';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import { StreamExecutionIndex } from '@agent/core/StreamExecutionIndex';
// Type imports
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// ============================================================================
// Snapshot Schema & Types
// ============================================================================

export const TOOL_USE_SNAPSHOT_VERSION = 1;

/**
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy snapshots that may contain removed or renamed fields.
 */
export const ToolUseSessionSnapshotSchema = z.object({
  version: z.literal(TOOL_USE_SNAPSHOT_VERSION),
  executionId: z.string(),
  streamId: z.string(),
  agentConfig: AgentConfigSchema,
  messages: z.array(ProviderMessageSchema),
  store: AgentSharedStoreSnapshotSchema,
  lastUpdated: z.number(),
});

/** Derived from ToolUseSessionSnapshotSchema - single source of truth */
export type ToolUseSessionSnapshot = z.infer<
  typeof ToolUseSessionSnapshotSchema
>;

/**
 * Input payload for saving a tool-use session snapshot.
 *
 * NOTE: This is a manual interface (not schema-derived) because `store` is an
 * AgentSharedStore class instance with methods (e.g., toSnapshot()), not a plain
 * data structure. Zod schemas cannot validate class instances with private fields.
 * The store is serialized to AgentSharedStoreSnapshot during the save operation.
 *
 * @see ToolUseSessionSnapshotSchema - SSOT for the serialized snapshot format
 */
export interface SaveToolUseSnapshotPayload {
  executionId: ExecutionId;
  streamId: StreamTabId;
  agentConfig: AgentConfig;
  messages: ProviderMessage[];
  store: AgentSharedStore;
}

// ============================================================================
// In-Memory Cache Manager
// ============================================================================

const CHANNEL = 'ToolUseSessionManager';
const logger = new AgentLogger(CHANNEL);

/**
 * Manages in-memory caching of tool-use session snapshots for resume capability.
 *
 * Provides:
 * - Dual-indexed storage (by stream ID and execution ID)
 * - Lazy registration from persisted snapshots on startup
 * - Explicit cleanup via clearByStream/clearByExecution
 */
export class ToolUseSessionManager {
  private static readonly index =
    new StreamExecutionIndex<ToolUseSessionSnapshot>();

  static registerSnapshots(snapshots: ToolUseSessionSnapshot[]): void {
    if (snapshots.length === 0) {
      return;
    }

    for (const snapshot of snapshots) {
      const executionId = snapshot.executionId as ExecutionId;
      const streamId = snapshot.streamId as StreamTabId;
      this.index.set(streamId, executionId, snapshot);
    }

    logger.debug(
      `Registered ${snapshots.length} pending tool-use snapshots for lazy resume.`,
    );
  }

  static cacheSnapshot(snapshot: ToolUseSessionSnapshot): void {
    const executionId = snapshot.executionId as ExecutionId;
    const streamId = snapshot.streamId as StreamTabId;
    this.index.set(streamId, executionId, snapshot);
    logger.debug(
      `Cached pending snapshot for stream ${snapshot.streamId} after persistence.`,
    );
  }

  static getByStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    return this.index.getByStream(streamId);
  }

  static clearByStream(streamId: StreamTabId): void {
    const entry = this.index.deleteByStream(streamId);
    if (!entry) {
      return;
    }
    logger.debug(`Cleared pending snapshot for stream ${streamId}.`);
  }

  static clearByExecution(
    executionId: ExecutionId,
  ): ToolUseSessionSnapshot | undefined {
    const entry = this.index.deleteByExecution(executionId);
    if (!entry) {
      return undefined;
    }
    logger.debug(`Cleared pending snapshot for execution ${executionId}.`);
    return entry.value;
  }

  static clearAll(): void {
    this.index.clear();
    logger.debug('Cleared all pending tool-use snapshots.');
  }
}
