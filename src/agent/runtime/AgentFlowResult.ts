import { z } from 'zod';

import type {
  AgentCategory,
  AttachedMemoryMiss,
  RunId,
  RunOutcome,
} from '@shared/schemas';
import {
  AttachedMemoryMissSchema,
  emptyRunEndOutput,
  RetryErrorInfoSchema,
  RunEndSchema,
  RunIdSchema,
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
 * `compositionHash` names the tool composition the run pinned; a host reports
 * it (the CLI's result line) and nothing persists it. A run stopped before
 * its loop returned carries none.
 */
const AgentFlowResultSchema = RunEndSchema.omit({ error: true }).extend({
  runId: RunIdSchema,
  memoryMisses: z.array(AttachedMemoryMissSchema).optional(),
  error: RetryErrorInfoSchema.optional(),
  compositionHash: z.string().optional(),
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
