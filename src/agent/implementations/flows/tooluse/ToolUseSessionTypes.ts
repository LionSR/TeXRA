/**
 * Tool-use session snapshot types and schemas.
 *
 * Provides Zod schema and types for session snapshots (single source of truth).
 * These are used for flow persistence via PersistedFlow.
 *
 * NOTE: The in-memory cache manager (ToolUseSessionManager) and disk persistence
 * (ToolUseSnapshotStore, ToolUseSessionPersistence) have been removed.
 * PersistedFlow now handles all persistence automatically.
 *
 * State architecture note: The snapshot schema still uses AgentSharedStoreSnapshotSchema
 * for backwards compatibility with existing persisted data. However, runtime code now
 * passes state slices directly without the AgentSharedStore wrapper class.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentSharedStoreSnapshotSchema } from '@agent/core/AgentSharedStore';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';

// ============================================================================
// Snapshot Schema & Types
// ============================================================================

export const TOOL_USE_SNAPSHOT_VERSION = 1;

/**
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy snapshots that may contain removed or renamed fields.
 *
 * Note: The `store` field uses AgentSharedStoreSnapshotSchema for backwards
 * compatibility with existing persisted snapshots. Runtime code now passes
 * individual state slices directly, reconstructing from snapshot.store.run,
 * snapshot.store.workspace, etc. as needed.
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
