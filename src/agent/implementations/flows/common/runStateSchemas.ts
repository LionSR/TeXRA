import { z } from 'zod';

import { AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { AgentSharedStoreSnapshotSchema } from '@agent/core/AgentSharedStore';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';

/** Base run state schema for serialization. */
export const BaseRunStateSchema = z.object({
  runState: AgentRunStateSnapshotSchema,
});

export type BaseRunStateSnapshot = z.infer<typeof BaseRunStateSchema>;

/** Workflow agent run state schema. */
export const ReflectionRunStateSchema = BaseRunStateSchema.extend({
  conversation: z.array(ProviderMessageSchema),
  totalRounds: z.number().int().nonnegative(),
  currentRound: z.number().int().nonnegative(),
  continueRounds: z.boolean(),
});

export type ReflectionRunStateSnapshot = z.infer<
  typeof ReflectionRunStateSchema
>;

/** Tool-use agent run state schema. */
export const ToolUseRunStateSchema = BaseRunStateSchema.extend({
  conversation: z.array(ProviderMessageSchema),
  // Runtime-only field, not serializable (contains functions)
  cycleOptions: z.unknown().nullable(),
  shouldSkipCycle: z.boolean(),
  store: AgentSharedStoreSnapshotSchema.nullable(),
});

export type ToolUseRunStateSnapshot = z.infer<typeof ToolUseRunStateSchema>;
