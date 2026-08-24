import { z } from 'zod';

import {
  AgentFinalResultSchema,
  WorkflowAgentFinalResultSchema,
  buildAgentFinalResult,
  type AgentFinalResult,
} from '@agent/runtime/AgentFinalResult';
import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import { ExecutionIdSchema, type RunOutcome } from '@shared/schemas';

const BackgroundBashResultMetaSchema = z.strictObject({
  producer: z.literal('backgroundBash'),
  exitCode: z.int().optional(),
  wallTimeMs: z.number().nonnegative(),
  success: z.boolean(),
  timedOut: z.boolean().optional(),
  command: z.string(),
});

const CliWorkflowResultMetaSchema = z.strictObject({
  producer: z.literal('cliWorkflow'),
  result: WorkflowAgentFinalResultSchema,
  copiedOutput: z.string().optional(),
  copiedOutputs: z.array(z.string()).optional(),
});

const SubagentResultMetaSchema = z.strictObject({
  producer: z.literal('subagent'),
  agentName: z.string(),
  /** Durable lineage used to verify a recovered workflow child. */
  parentExecutionId: ExecutionIdSchema.optional(),
  wallTimeMs: z.number().nonnegative(),
  result: AgentFinalResultSchema,
  /**
   * Logical turn this envelope belongs to (#9531, introduced 2026-08-03).
   * Absent on records persisted before turn identity existed; absence simply
   * means "predates turn attribution", so the field stays optional rather
   * than prefaulted to an invented token.
   */
  turnToken: z.string().optional(),
});

/** Canonical persisted result record. */
export const ResultMetaSchema = z.discriminatedUnion('producer', [
  BackgroundBashResultMetaSchema,
  CliWorkflowResultMetaSchema,
  SubagentResultMetaSchema,
]);

export type ResultMeta = z.infer<typeof ResultMetaSchema>;

/** Remove persistence-only producer context from the public result value. */
export function unwrapResultMeta(
  meta: ResultMeta,
): AgentFinalResult | Extract<ResultMeta, { producer: 'backgroundBash' }> {
  return meta.producer === 'backgroundBash' ? meta : meta.result;
}

/** Wrap a CLI workflow result in the canonical producer record. */
export function buildCliWorkflowResultMeta(
  flowResult: WorkflowFlowResult,
  options: {
    readonly outcome?: RunOutcome;
    readonly copiedOutput?: string;
    readonly copiedOutputs?: readonly string[];
  } = {},
): Extract<ResultMeta, { producer: 'cliWorkflow' }> {
  return {
    producer: 'cliWorkflow',
    result: buildAgentFinalResult({
      flowResult,
      outcome: options.outcome,
    }),
    ...(options.copiedOutput !== undefined && {
      copiedOutput: options.copiedOutput,
    }),
    ...(options.copiedOutputs !== undefined && {
      copiedOutputs: [...options.copiedOutputs],
    }),
  };
}
