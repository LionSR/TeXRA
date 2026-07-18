import { z } from 'zod';

import { AttachedMemoryMissSchema } from '@agent/types/AttachedMemory';
import {
  ExecutionIdSchema,
  RunOutcomeSchema,
  STREAM_PHASE,
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
  /** Value captured by the `submit_output` terminal tool, if the run used one. */
  structured: z.unknown().optional(),
});

const AgentFlowResultSchema = z.discriminatedUnion('category', [
  WorkflowFlowResultSchema,
  ToolUseFlowResultSchema,
]);

export type AgentFlowResult = z.infer<typeof AgentFlowResultSchema>;

const WaitingToolUseFlowResultSchema = AgentFlowMetaSchema.extend({
  category: z.literal('toolUse'),
  outcome: z.literal(STREAM_PHASE.WAITING),
  lastResponse: z.string().optional(),
  /** Workspace-relative paths of files edited by tool calls during this session. */
  touchedFiles: z.array(z.string()).optional(),
});

export type WaitingToolUseFlowResult = z.infer<
  typeof WaitingToolUseFlowResultSchema
>;

/** Runtime flow results include the non-terminal WAITING state. */
export type AgentRuntimeFlowResult = AgentFlowResult | WaitingToolUseFlowResult;

export function isWaitingFlowResult(
  result: AgentRuntimeFlowResult | unknown,
): result is WaitingToolUseFlowResult {
  if (!result || typeof result !== 'object') return false;
  const candidate = result as { category?: unknown; outcome?: unknown };
  return (
    candidate.category === 'toolUse' &&
    candidate.outcome === STREAM_PHASE.WAITING
  );
}

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

/**
 * Optional `AgentFlowResult` fields shared by both result categories. Included
 * only when meaningful so an empty miss list or a zero cost never lands in the
 * result — the single owner of that inclusion rule for every builder.
 */
export function buildOptionalFlowResultFields(
  memoryMisses: AgentFlowResult['memoryMisses'],
  totalCostUsd: number | undefined,
): { memoryMisses?: AgentFlowResult['memoryMisses']; totalCostUsd?: number } {
  return {
    ...(memoryMisses && memoryMisses.length > 0 ? { memoryMisses } : {}),
    ...(totalCostUsd != null && totalCostUsd > 0 ? { totalCostUsd } : {}),
  };
}

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
    ...buildOptionalFlowResultFields(memoryMisses, undefined),
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
