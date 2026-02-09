/**
 * Unified result schemas for agent flow execution.
 *
 * Zod schemas are the single source of truth — TypeScript types are
 * derived via z.infer. This enables runtime validation if these types
 * ever cross a serialization boundary (e.g. webview messaging).
 */

import { z } from 'zod';

import {
  EndGroupStatusSchema,
  ExecutionIdSchema,
  StreamTabIdSchema,
} from '@shared/schemas';

// ============================================================================
// Output file summary
// ============================================================================

export const OutputFileSummarySchema = z.object({
  /** Which round produced this file (0-indexed) */
  round: z.number(),
  /** Relative path to generated file */
  relativePath: z.string(),
  /** Absolute path to generated file */
  absolutePath: z.string(),
  /** Where the file lives: workspace root, task run storage, or external */
  location: z.enum(['workspace', 'runStorage', 'external']),
  /** Which input file produced this output */
  originalPath: z.string().nullable(),
  /** Lines added */
  added: z.number().nullable(),
  /** Lines removed */
  removed: z.number().nullable(),
});

export type OutputFileSummary = z.infer<typeof OutputFileSummarySchema>;

// ============================================================================
// Shared metadata
// ============================================================================

const AgentFlowMetaSchema = z.object({
  /** Execution ID — usable with the runs tool for progress checks. */
  executionId: ExecutionIdSchema,
  /** The real stream ID assigned to the subagent. */
  streamId: StreamTabIdSchema,
});

export type AgentFlowMeta = z.infer<typeof AgentFlowMetaSchema>;

// ============================================================================
// Flow result variants (discriminated on `category`)
// ============================================================================

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
});

export type ToolUseFlowResult = z.infer<typeof ToolUseFlowResultSchema>;

// ============================================================================
// Union
// ============================================================================

export const AgentFlowResultSchema = z.discriminatedUnion('category', [
  WorkflowFlowResultSchema,
  ToolUseFlowResultSchema,
]);

export type AgentFlowResult = z.infer<typeof AgentFlowResultSchema>;
