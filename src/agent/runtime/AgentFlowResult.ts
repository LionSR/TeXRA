import { z } from 'zod';

import { AttachedMemoryMissSchema } from '@agent/types/AttachedMemory';
import type { ExecutionId, RunOutcome, StreamTabId } from '@shared/schemas';
import {
  CompileFailureSummarySchema,
  ExecutionIdSchema,
  OutputFileSummarySchema,
  RetryErrorInfoSchema,
  RunOutcomeSchema,
  STREAM_PHASE,
  StreamTabIdSchema,
} from '@shared/schemas';

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
  /**
   * The structured provider error of a run that ended FAILED. This is the one
   * carrier for a failure that still has a result: a flow reports its failure
   * on the result it returns rather than through an exception subclass, and
   * `runFlowWithLifecycle` reads it to classify, log, and publish the terminal
   * error facts. Absent on every non-failed outcome.
   */
  error: RetryErrorInfoSchema.optional(),
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
  response: z.string().optional(),
  /** Workspace-relative paths of files edited by tool calls during this session. */
  files: z.array(z.string()).optional(),
  /** Value captured by the `submit_output` terminal tool, if the run used one. */
  structured: z.unknown().optional(),
});

export type ToolUseFlowResult = z.infer<typeof ToolUseFlowResultSchema>;

const AgentFlowResultSchema = z.discriminatedUnion('category', [
  WorkflowFlowResultSchema,
  ToolUseFlowResultSchema,
]);

export type AgentFlowResult = z.infer<typeof AgentFlowResultSchema>;

// A suspension is not a terminal fact, so it can never carry a failure: a flow
// that recorded an error ends the run instead of parking it.
const WaitingToolUseFlowResultSchema = AgentFlowMetaSchema.omit({
  error: true,
})
  .extend({
    category: z.literal('toolUse'),
    outcome: z.literal(STREAM_PHASE.WAITING),
  })
  .extend(ToolUseFlowResultSchema.pick({ response: true, files: true }).shape);

export type WaitingToolUseFlowResult = z.infer<
  typeof WaitingToolUseFlowResultSchema
>;

/** Runtime flow results include the non-terminal WAITING state. */
export type AgentRuntimeFlowResult = AgentFlowResult | WaitingToolUseFlowResult;

export function isWaitingFlowResult(
  result: unknown,
): result is WaitingToolUseFlowResult {
  if (!result || typeof result !== 'object') return false;
  const candidate = result as { category?: unknown; outcome?: unknown };
  return (
    candidate.category === 'toolUse' &&
    candidate.outcome === STREAM_PHASE.WAITING
  );
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
    ...(memoryMisses?.length ? { memoryMisses } : {}),
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
