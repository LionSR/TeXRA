import { z } from 'zod';

import {
  EndGroupStatusSchema,
  ExecutionIdSchema,
  StreamTabIdSchema,
} from '@shared/schemas';

export const OutputFileSummarySchema = z.object({
  round: z.number(),
  relativePath: z.string(),
  absolutePath: z.string(),
  location: z.enum(['workspace', 'runStorage', 'external']),
  originalPath: z.string().nullable(),
  added: z.number().nullable(),
  removed: z.number().nullable(),
});

export type OutputFileSummary = z.infer<typeof OutputFileSummarySchema>;

const AgentFlowMetaSchema = z.object({
  executionId: ExecutionIdSchema,
  streamId: StreamTabIdSchema,
});

export const WorkflowFlowResultSchema = AgentFlowMetaSchema.extend({
  category: z.literal('workflow'),
  status: EndGroupStatusSchema,
  outputs: z.array(OutputFileSummarySchema),
});

export type WorkflowFlowResult = z.infer<typeof WorkflowFlowResultSchema>;

export const ToolUseFlowResultSchema = AgentFlowMetaSchema.extend({
  category: z.literal('toolUse'),
  status: EndGroupStatusSchema,
  lastResponse: z.string().optional(),
  /** Workspace-relative paths of files edited by tool calls during this session. */
  touchedFiles: z.array(z.string()).optional(),
});

export type ToolUseFlowResult = z.infer<typeof ToolUseFlowResultSchema>;

export const AgentFlowResultSchema = z.discriminatedUnion('category', [
  WorkflowFlowResultSchema,
  ToolUseFlowResultSchema,
]);

export type AgentFlowResult = z.infer<typeof AgentFlowResultSchema>;
