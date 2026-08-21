import { z } from 'zod';

import {
  AgentFinalResultSchema,
  WorkflowAgentFinalResultSchema,
  buildAgentFinalResult,
  type AgentFinalResult,
} from '@agent/runtime/AgentFinalResult';
import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import {
  ExecutionIdSchema,
  RUN_OUTCOME,
  type RunOutcome,
} from '@shared/schemas';

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
  /** Legacy single-file field, no longer written; kept so pre-existing persisted records still parse. */
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

/**
 * Project the execution's durable terminal outcome onto a persisted result
 * record. `meta.outcome` is the only writer of "how did this run end": the
 * result record is an interim envelope rewritten by every turn, and a run can
 * end after its last turn wrote one (interrupted between turns, stopped while
 * suspended, failed by restart repair). A durable `completed` is never
 * projected: it only ever agrees with the envelope, whose producer may already
 * have downgraded a nominally completed flow that reported an application-level
 * error (`buildSubagentFailureResultMeta`).
 */
export function applyExecutionOutcome(
  record: ResultMeta,
  executionOutcome: RunOutcome | undefined,
): ResultMeta {
  if (
    record.producer === 'backgroundBash' ||
    executionOutcome === undefined ||
    executionOutcome === RUN_OUTCOME.COMPLETED ||
    record.result.outcome === executionOutcome
  ) {
    return record;
  }
  return ResultMetaSchema.parse({
    ...record,
    result: { ...record.result, outcome: executionOutcome },
  });
}

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
    readonly copiedOutputs?: readonly string[];
  } = {},
): Extract<ResultMeta, { producer: 'cliWorkflow' }> {
  return {
    producer: 'cliWorkflow',
    result: buildAgentFinalResult({
      flowResult,
      outcome: options.outcome,
    }),
    ...(options.copiedOutputs !== undefined && {
      copiedOutputs: [...options.copiedOutputs],
    }),
  };
}
