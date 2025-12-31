/**
 * Tool-use session snapshot types and schemas.
 *
 * Provides Zod schema and types for session snapshots (single source of truth).
 * These are used for flow persistence via PersistedFlow.
 *
 * NOTE: The in-memory cache manager (ToolUseSessionManager) and disk persistence
 * (ToolUseSnapshotStore, ToolUseSessionPersistence) have been removed.
 * PersistedFlow now handles all persistence automatically.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { AgentSharedStoreSnapshotSchema } from '@agent/core/AgentSharedStore';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';

// Type imports
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

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
