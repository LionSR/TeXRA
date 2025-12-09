// Third-party imports
import { z } from 'zod';

// Local imports
import { AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';

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

/**
 * Reflection agent run state schema (for serialization).
 * @see ReflectionRunState in ReflectionRunFlow.ts for runtime type
 */
export const ReflectionRunStateSchema = BaseRunStateSchema.extend({
  conversation: z.array(z.any()),
  totalRounds: z.number().int().nonnegative(),
  currentRound: z.number().int().nonnegative(),
  continueRounds: z.boolean(),
});

export type ReflectionRunStateSnapshot = z.infer<
  typeof ReflectionRunStateSchema
>;

/**
 * Tool-use agent run state schema (for serialization).
 * @see ToolUseRunState in ToolUseRunFlow.ts for runtime type
 */
export const ToolUseRunStateSchema = BaseRunStateSchema.extend({
  conversation: z.array(ProviderMessageSchema),
  cycleOptions: z.unknown().nullable(),
  shouldSkipCycle: z.boolean(),
  store: z.unknown().nullable(),
});

export type ToolUseRunStateSnapshot = z.infer<typeof ToolUseRunStateSchema>;
