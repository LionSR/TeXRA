/**
 * AgentSharedStore snapshot schema for backwards compatibility.
 *
 * This file provides the Zod schema for parsing legacy session snapshots
 * that bundled state slices into a single "store" object.
 *
 * NOTE: The AgentSharedStore class has been removed. Production code now
 * passes state slices directly:
 * - AgentRunState.fromSnapshot() / .toSnapshot()
 * - AgentWorkspaceState.fromSnapshot() / .toSnapshot()
 * - UserVariableChannels passed directly
 *
 * The schema is retained only for backwards-compatible snapshot parsing
 * when resuming old sessions.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - snapshot schemas only (no class imports needed)
import {
  AgentRunStateSnapshotSchema,
  ConversationRoundStateSnapshotSchema,
} from './AgentState';
import { AgentWorkspaceStateSnapshotSchema } from './AgentWorkspaceState';
import { UserVariableChannelsSchema } from './AgentCycleOptions';

/**
 * Schema for legacy store snapshots.
 *
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy store snapshots that may contain removed or renamed fields.
 */
export const AgentSharedStoreSnapshotSchema = z.object({
  round: ConversationRoundStateSnapshotSchema,
  run: AgentRunStateSnapshotSchema,
  workspace: AgentWorkspaceStateSnapshotSchema,
  user: UserVariableChannelsSchema,
});

/**
 * Type for legacy store snapshots.
 * Uses z.output<> to get the type after parsing (all fields required).
 */
export type AgentSharedStoreSnapshot = z.output<
  typeof AgentSharedStoreSnapshotSchema
>;
