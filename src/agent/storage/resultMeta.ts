import { buildAgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import type { AgentFinalResult } from '@shared/schemas';
import type { RunOutcome } from '@shared/schemas';

import type { ResultMeta } from '@shared/schemas';
export { ResultMetaSchema, type ResultMeta } from '@shared/schemas';

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
