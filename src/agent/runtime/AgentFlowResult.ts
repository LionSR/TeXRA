import { z } from 'zod';

import { AttachedMemoryMissSchema } from '@agent/types/AttachedMemory';
import {
  ExecutionIdSchema,
  RunOutcomeSchema,
  StreamTabIdSchema,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import {
  CompileFailureSummarySchema,
  OutputFileSummarySchema,
} from '@shared/schemas/output';

const AgentFlowMetaSchema = z.object({
  executionId: ExecutionIdSchema,
  streamId: StreamTabIdSchema,
  memoryMisses: z.array(AttachedMemoryMissSchema).optional(),
  /**
   * Total model cost (USD) of the run, including its own subagents.
   * Parents use this to roll a completed subagent's spend into their own
   * usage totals without branching on the subagent flow.
   */
  totalCostUsd: z.number().nonnegative().optional(),
});

export const WorkflowFlowResultSchema = AgentFlowMetaSchema.extend({
  category: z.literal('workflow'),
  outcome: RunOutcomeSchema,
  outputs: z.array(OutputFileSummarySchema),
  compileFailures: z.array(CompileFailureSummarySchema).prefault(() => []),
});

export type WorkflowFlowResult = z.infer<typeof WorkflowFlowResultSchema>;

export const ToolUseFlowResultSchema = AgentFlowMetaSchema.extend({
  category: z.literal('toolUse'),
  outcome: RunOutcomeSchema,
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

export class AgentFlowError extends Error {
  constructor(
    message: string,
    readonly result: AgentFlowResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentFlowError';
  }
}

export function getAgentFlowErrorResult(
  error: unknown,
): AgentFlowResult | undefined {
  return error instanceof AgentFlowError ? error.result : undefined;
}

/** The discriminant of {@link AgentFlowResult}: which flow produced the result. */
export type AgentFlowCategory = AgentFlowResult['category'];

export function buildTerminalFlowResult(
  category: AgentFlowCategory,
  outcome: RunOutcome,
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
    return { category, outcome, ...meta };
  }
  return {
    category,
    outcome,
    ...meta,
    outputs: [],
    compileFailures: [],
  };
}
