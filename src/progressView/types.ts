import { z } from 'zod';

import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import { ExecutionIdSchema } from '@agent/types/IdentifierTypes';
import type { AgentTypeFilter } from '@agent/types/AgentStreamTypes';

// ============================================================================
// Progress View Schemas
// ============================================================================

export const StreamUITraitsSchema = z.object({
  sessionKind: z.nativeEnum(AgentCategory),
  isToolAgent: z.boolean(),
});
export type StreamUITraits = z.infer<typeof StreamUITraitsSchema>;

export const StreamTabInfoSchema = z.object({
  name: z.string(),
  label: z.string(),
  model: z.string().optional(),
  agent: z.string().optional(),
  agentType: z.nativeEnum(AgentType).optional(),
  agentSessionKind: z.nativeEnum(AgentCategory),
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

export type AgentFilter = AgentTypeFilter;

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
