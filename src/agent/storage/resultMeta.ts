import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import { runEndErrorOf } from '@common/errors/agentErrorClassification';
import { RUN_OUTCOME, type RunEnd, type RunOutcome } from '@shared/schemas';

import type { ResultMeta } from '@shared/schemas';
export { ResultMetaSchema, type ResultMeta } from '@shared/schemas';

/** Remove persistence-only producer context from the public result value. */
export function unwrapResultMeta(
  meta: ResultMeta,
): RunEnd | Extract<ResultMeta, { producer: 'backgroundBash' }> {
  return meta.producer === 'backgroundBash' ? meta : meta.result;
}

/**
 * Wrap a CLI workflow result in the canonical producer record. Error facts
 * travel only with the outcome they describe: a caller that re-stamps a
 * nominally completed flow as failed keeps the flow's error (when it recorded
 * one); any non-failed outcome drops it.
 */
export function buildCliWorkflowResultMeta(
  flowResult: WorkflowFlowResult,
  options: {
    readonly outcome?: RunOutcome;
    readonly copiedOutput?: string;
    readonly copiedOutputs?: readonly string[];
  } = {},
): Extract<ResultMeta, { producer: 'cliWorkflow' }> {
  const outcome = options.outcome ?? flowResult.outcome;
  return {
    producer: 'cliWorkflow',
    result: {
      outcome,
      ...(outcome === RUN_OUTCOME.FAILED && flowResult.error !== undefined
        ? { error: runEndErrorOf(flowResult.error) }
        : {}),
      ...(flowResult.usage !== undefined ? { usage: flowResult.usage } : {}),
      output: flowResult.output,
    },
    ...(options.copiedOutput !== undefined && {
      copiedOutput: options.copiedOutput,
    }),
    ...(options.copiedOutputs !== undefined && {
      copiedOutputs: [...options.copiedOutputs],
    }),
  };
}
