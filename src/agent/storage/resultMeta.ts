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
  PersistedRetryErrorInfoSchema,
  type RunOutcome,
} from '@shared/schemas';
import { isObject } from '@utils/core';

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

/** Persisted result-meta reader introduced 2026-08-31 for failed records
 * written before the canonical provider classification shipped. Remove after
 * 2026-11-30, when those files have aged out. Writers and
 * AgentFinalResultSchema remain canonical-only. */
export const PersistedResultMetaSchema = z.preprocess((value) => {
  if (!isObject(value) || !isObject(value.result)) return value;
  const error = value.result.error;
  if (error === undefined) return value;

  const parsed = PersistedRetryErrorInfoSchema.safeParse(error);
  return parsed.success
    ? { ...value, result: { ...value.result, error: parsed.data } }
    : value;
}, ResultMetaSchema);

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
