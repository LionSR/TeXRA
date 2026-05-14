import { z } from 'zod';

import {
  EndGroupStatusSchema,
  ExecutionIdSchema,
  StreamTabIdSchema,
} from '@shared/schemas';

export const OutputFileSummarySchema = z.object({
  round: z.int().nonnegative(),
  relativePath: z.string(),
  absolutePath: z.string(),
  location: z.enum(['workspace', 'runStorage', 'external']),
  originalPath: z.string().nullable(),
  added: z.int().nonnegative().nullable(),
  removed: z.int().nonnegative().nullable(),
});

export type OutputFileSummary = z.infer<typeof OutputFileSummarySchema>;

export const CompileFailureSummarySchema = z.object({
  round: z.int().nonnegative(),
  displayName: z.string(),
  outputPath: z.string(),
  logPath: z.string(),
  logAbsolutePath: z.string(),
});

export type CompileFailureSummary = z.infer<typeof CompileFailureSummarySchema>;

const AgentFlowMetaSchema = z.object({
  executionId: ExecutionIdSchema,
  streamId: StreamTabIdSchema,
});

export const WorkflowFlowResultSchema = AgentFlowMetaSchema.extend({
  category: z.literal('workflow'),
  status: EndGroupStatusSchema,
  outputs: z.array(OutputFileSummarySchema),
  compileFailures: z.array(CompileFailureSummarySchema).prefault(() => []),
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
