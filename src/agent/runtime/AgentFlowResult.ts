import { z } from 'zod';

import {
  AttachedMemoryMissSchema,
  type AttachedMemoryMiss,
} from '@agent/types/AttachedMemory';
import type { AgentCategory, RunId, RunOutcome } from '@shared/schemas';
import {
  emptyRunEndOutput,
  RetryErrorInfoSchema,
  RunEndSchema,
  RunIdSchema,
  RUN_PHASE,
  ToolUseRunEndOutputSchema,
  WorkflowRunEndOutputSchema,
} from '@shared/schemas';

/**
 * A flow's report to the lifecycle: the `run.end` payload while it is still
 * an in-memory hand-off, plus the run it belongs to and the attached-memory
 * misses the delivery reports. `error` is the flow's own provider/runtime
 * error, not yet classified; `runFlowWithLifecycle` classifies it into the
 * `run.end` row's error. Domain verdicts such as rejected workflow output end
 * FAILED without one, their diagnostics staying in the output.
 */
const AgentFlowResultSchema = RunEndSchema.omit({ error: true }).extend({
  runId: RunIdSchema,
  memoryMisses: z.array(AttachedMemoryMissSchema).optional(),
  error: RetryErrorInfoSchema.optional(),
});

export type AgentFlowResult = z.infer<typeof AgentFlowResultSchema>;

export const WorkflowFlowResultSchema = AgentFlowResultSchema.extend({
  output: WorkflowRunEndOutputSchema,
});

export type WorkflowFlowResult = z.infer<typeof WorkflowFlowResultSchema>;

export const ToolUseFlowResultSchema = AgentFlowResultSchema.extend({
  output: ToolUseRunEndOutputSchema,
});

export type ToolUseFlowResult = z.infer<typeof ToolUseFlowResultSchema>;

// A suspension is not a terminal fact, so it can never carry a failure: a flow
// that recorded an error ends the run instead of parking it.
const WaitingToolUseFlowResultSchema = ToolUseFlowResultSchema.omit({
  error: true,
}).extend({
  outcome: z.literal(RUN_PHASE.WAITING),
});

export type WaitingToolUseFlowResult = z.infer<
  typeof WaitingToolUseFlowResultSchema
>;

/** Runtime flow results include the non-terminal WAITING state. */
export type AgentRuntimeFlowResult = AgentFlowResult | WaitingToolUseFlowResult;

export function isWaitingFlowResult(
  result: AgentRuntimeFlowResult,
): result is WaitingToolUseFlowResult {
  return result.outcome === RUN_PHASE.WAITING;
}

/** The report of a run that ended before its flow produced an output. */
export function buildTerminalFlowResult(
  category: AgentCategory,
  outcome: RunOutcome,
  runId: RunId,
  memoryMisses?: AttachedMemoryMiss[],
): AgentFlowResult {
  return {
    outcome,
    output: emptyRunEndOutput(category),
    runId,
    ...(memoryMisses?.length ? { memoryMisses } : {}),
  };
}
