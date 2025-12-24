// Third-party imports
import { z } from 'zod';

// Local imports
import { AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { AgentSharedStoreSnapshotSchema } from '@agent/core/AgentSharedStore';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';

// ============================================================================
// BASE RUN STATE SCHEMA
// ============================================================================

/**
 * Base run state schema for serialization.
 *
 * These schemas define the serialization format for agent run states.
 * Runtime state uses class instances (AgentRunState) while schemas use
 * snapshot representations for JSON compatibility.
 */
export const BaseRunStateSchema = z.object({
  runState: AgentRunStateSnapshotSchema,
});

export type BaseRunStateSnapshot = z.infer<typeof BaseRunStateSchema>;

// ============================================================================
// WORKFLOW (REFLECTION) RUN STATE SCHEMA
// ============================================================================

/**
 * Reflection agent run state schema (for serialization).
 *
 * Used by workflow agents (CoT, Direct) for multi-round document processing.
 * @see ReflectionRunState in ReflectionRunFlow.ts for runtime type
 */
export const ReflectionRunStateSchema = BaseRunStateSchema.extend({
  /** Conversation history - uses ProviderMessageSchema for type safety */
  conversation: z.array(ProviderMessageSchema),
  /** Total number of rounds configured for this run */
  totalRounds: z.number().int().nonnegative(),
  /** Current round index (0-based) */
  currentRound: z.number().int().nonnegative(),
  /** Whether to continue to the next round */
  continueRounds: z.boolean(),
});

export type ReflectionRunStateSnapshot = z.infer<
  typeof ReflectionRunStateSchema
>;

// ============================================================================
// TOOL-USE RUN STATE SCHEMA
// ============================================================================

/**
 * Tool-use agent run state schema (for serialization).
 *
 * Used by interactive tool-use agents for session-based execution.
 * @see ToolUseRunState in ToolUseRunFlow.ts for runtime type
 */
export const ToolUseRunStateSchema = BaseRunStateSchema.extend({
  /** Conversation history with properly typed messages */
  conversation: z.array(ProviderMessageSchema),
  /**
   * Cycle options - intentionally z.unknown() because it contains
   * runtime-only values (modelHandler, functions) that cannot be serialized.
   * This field is reconstructed at runtime, not persisted.
   */
  cycleOptions: z.unknown().nullable(),
  /** Whether to skip the next cycle (e.g., after resume) */
  shouldSkipCycle: z.boolean(),
  /** Shared store snapshot for state persistence */
  store: AgentSharedStoreSnapshotSchema.nullable(),
});

export type ToolUseRunStateSnapshot = z.infer<typeof ToolUseRunStateSchema>;
