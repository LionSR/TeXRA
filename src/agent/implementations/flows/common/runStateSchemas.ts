// Third-party imports
import { z } from 'zod';

// Local imports
import { AgentRunState, AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';

// Type imports
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

/**
 * Base run state schema for serialization/validation.
 *
 * These schemas define the serialization format for agent run states.
 * Runtime state uses class instances (AgentRunState) while schemas use
 * snapshot representations for JSON compatibility.
 *
 * @example
 * ```typescript
 * const ReflectionRunStateSchema = BaseRunStateSchema.extend({
 *   totalRounds: z.number(),
 *   currentRound: z.number(),
 *   continueRounds: z.boolean(),
 * });
 * ```
 */
export const BaseRunStateSchema = z.object({
  /**
   * Accumulated run statistics including usage, rounds, and timing.
   * Uses snapshot schema for JSON serialization compatibility.
   */
  runState: AgentRunStateSnapshotSchema,
});

/**
 * Base run state snapshot type (for serialization).
 * Runtime interfaces in flow files use AgentRunState class instances.
 */
export type BaseRunStateSnapshot = z.infer<typeof BaseRunStateSchema>;

/**
 * Reflection agent run state schema (for serialization).
 * Extends BaseRunStateSchema with round-specific fields.
 *
 * Runtime equivalent: ReflectionRunState in ReflectionRunFlow.ts
 */
export const ReflectionRunStateSchema = BaseRunStateSchema.extend({
  /** Conversation history - uses any[] for provider-agnostic storage */
  conversation: z.array(z.any()),
  /** Total number of rounds to execute */
  totalRounds: z.number().int().nonnegative(),
  /** Current round index (0-based) */
  currentRound: z.number().int().nonnegative(),
  /** Whether to continue to the next round */
  continueRounds: z.boolean(),
});

/**
 * Reflection run state snapshot type (for serialization).
 * @see ReflectionRunState in ReflectionRunFlow.ts for runtime type
 */
export type ReflectionRunStateSnapshot = z.infer<
  typeof ReflectionRunStateSchema
>;

/**
 * Tool-use agent run state schema (for serialization).
 * Extends BaseRunStateSchema with tool-use specific fields.
 *
 * Runtime equivalent: ToolUseRunState in ToolUseRunFlow.ts
 */
export const ToolUseRunStateSchema = BaseRunStateSchema.extend({
  /** Conversation history with typed provider messages */
  conversation: z.array(ProviderMessageSchema),
  /** Cycle options - nullable until prepared */
  cycleOptions: z.unknown().nullable(),
  /** Flag to skip the current cycle (e.g., for resume) */
  shouldSkipCycle: z.boolean(),
  /** Shared store for tool state - nullable until prepared */
  store: z.unknown().nullable(),
});

/**
 * Tool-use run state snapshot type (for serialization).
 * @see ToolUseRunState in ToolUseRunFlow.ts for runtime type
 */
export type ToolUseRunStateSnapshot = z.infer<typeof ToolUseRunStateSchema>;

/**
 * Type guard to check if a value has the base run state structure.
 * Works with both runtime (class instance) and serialized (snapshot) forms.
 */
export function isBaseRunState(
  value: unknown,
): value is { runState: AgentRunState | BaseRunStateSnapshot['runState'] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'runState' in value &&
    typeof value.runState === 'object' &&
    value.runState !== null
  );
}

// Re-export ProviderMessage schema for convenience
export { ProviderMessageSchema };
export type { ProviderMessage };
