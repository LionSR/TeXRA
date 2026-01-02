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
 * Schema architecture: Individual state slices are stored directly (no wrapper).
 * This eliminates the AgentSharedStore abstraction overhead.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { AgentWorkspaceStateSnapshotSchema } from '@agent/core/AgentWorkspaceState';
import { UserVariableChannelsSchema } from '@agent/core/AgentCycleOptions';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';

// ============================================================================
// Snapshot Schema & Types
// ============================================================================

export const TOOL_USE_SNAPSHOT_VERSION = 2;

/**
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy snapshots that may contain removed or renamed fields.
 *
 * Version 2: State slices stored directly (no wrapper object).
 * - run: AgentRunStateSnapshot
 * - workspace: AgentWorkspaceSnapshot
 * - user: UserVariableChannels
 */
export const ToolUseSessionSnapshotSchema = z.object({
  version: z.literal(TOOL_USE_SNAPSHOT_VERSION),
  executionId: z.string(),
  streamId: z.string(),
  agentConfig: AgentConfigSchema,
  messages: z.array(ProviderMessageSchema),
  // State slices stored directly (no wrapper)
  run: AgentRunStateSnapshotSchema,
  workspace: AgentWorkspaceStateSnapshotSchema,
  user: UserVariableChannelsSchema,
  lastUpdated: z.number(),
});

/** Derived from ToolUseSessionSnapshotSchema - single source of truth */
export type ToolUseSessionSnapshot = z.infer<
  typeof ToolUseSessionSnapshotSchema
>;
