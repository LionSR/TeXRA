import { z } from 'zod';

import { AgentCategory } from '@agent/core/AgentDataclass';
import { ExecutionIdSchema } from '@agent/types/IdentifierTypes';

// ============================================================================
// Progress View Schemas
// ============================================================================

export const StreamUITraitsSchema = z.object({
  agentCategory: z.nativeEnum(AgentCategory),
  isToolAgent: z.boolean(),
});
export type StreamUITraits = z.infer<typeof StreamUITraitsSchema>;

export const StreamTabInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  model: z.string().optional(),
  agent: z.string().optional(),
  agentCategory: z.nativeEnum(AgentCategory),
  uiTraits: StreamUITraitsSchema,
  hasMultipleOutputs: z.boolean().optional(),
  isRemote: z.boolean().optional(),
  lastTimestamp: z.number().optional(),
  inputFile: z.string().optional(),
  creationTimestamp: z.number().optional(),
  status: z.string().optional(),
  executionId: ExecutionIdSchema.optional(),
});
export type StreamTabInfo = z.infer<typeof StreamTabInfoSchema>;

export const InstructionMetadataSchema = z.object({
  showToggle: z.boolean().optional(),
  expanded: z.boolean().optional(),
});
export type InstructionMetadata = z.infer<typeof InstructionMetadataSchema>;

export const InstructionUpdateSchema = z.object({
  text: z.string(),
  metadata: InstructionMetadataSchema.optional(),
});
export type InstructionUpdate = z.infer<typeof InstructionUpdateSchema>;

// ============================================================================
// Round Data Types
// ============================================================================

/**
 * Map from round number to items for that round.
 * Used for output files, missing outputs, etc. that are organized by round.
 */
export type RoundMap<T> = Map<number, T[]>;

/**
 * Map from run ID to round maps (run → round → items).
 * Nested structure for per-run, per-round data.
 */
export type RunRoundMap<T> = Map<string, RoundMap<T>>;
