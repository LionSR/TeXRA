import { z } from 'zod';

import { AttachedMemoryMissSchema } from '@agent/types/AttachedMemory';
import {
  EndGroupStatusSchema,
  ExecutionIdSchema,
  StreamTabIdSchema,
  type EndGroupStatus,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

/**
 * Flattened projection of {@link OutputFileInfo} for use in {@link AgentFlowResult}.
 *
 * The internal `OutputFileInfo` carries rich `FileLocationSchema` objects, full
 * `FileLineageSchema` chains, and complete `DiffStats`. This summary strips those
 * down to plain strings and scalars so the result can be cleanly serialized and
 * consumed by orchestrators or storage without dragging in location internals.
 *
 * Conversion: see `toOutputSummaries()` in `executeAgent.ts`.
 */
export const OutputFileSummarySchema = z.object({
  round: z.int().nonnegative(),
  relativePath: z.string(),
  absolutePath: z.string(),
  /** The `kind` discriminant of the source `FileLocation`. */
  location: z.enum(['workspace', 'runStorage', 'external']),
  /**
   * Absolute path of the lineage base file (diffBase takes precedence over
   * original when both are present), or null if no lineage was recorded.
   */
  originalPath: z.string().nullable(),
  added: z.int().nonnegative().nullable(),
  removed: z.int().nonnegative().nullable(),
});

export type OutputFileSummary = z.infer<typeof OutputFileSummarySchema>;

/**
 * Flattened projection of {@link CompileFailure} for use in {@link AgentFlowResult}.
 *
 * `CompileFailure` stores `FileLocationSchema` objects for `output` and `log`.
 * This summary extracts plain paths: `outputPath` is workspace-relative for
 * non-external files (absolute for external), `logPath` is always relative,
 * and `logAbsolutePath` is always absolute for direct opening.
 *
 * Conversion: see `toCompileFailureSummaries()` in `executeAgent.ts`.
 */
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
  memoryMisses: z.array(AttachedMemoryMissSchema).optional(),
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

/** The discriminant of {@link AgentFlowResult}: which flow produced the result. */
export type AgentFlowCategory = AgentFlowResult['category'];

export function buildTerminalFlowResult(
  category: AgentFlowCategory,
  status: EndGroupStatus,
  executionId: ExecutionId,
  streamId: StreamTabId,
  memoryMisses?: z.infer<typeof AttachedMemoryMissSchema>[],
): AgentFlowResult {
  const meta = {
    executionId,
    streamId,
    ...(memoryMisses && memoryMisses.length > 0 ? { memoryMisses } : {}),
  };
  if (category === 'toolUse') {
    return { category, status, ...meta };
  }
  return {
    category,
    status,
    ...meta,
    outputs: [],
    compileFailures: [],
  };
}
