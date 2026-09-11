import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import type { ResultMeta, RunEnd, RunOutcome } from '@shared/schemas';

/**
 * The public value of one run's result endpoint: the run's terminal fact,
 * carrying the output as the producer's delivery enriched it (a workflow
 * subagent's diffs are computed after the flow reported), with the
 * persistence-only producer context dropped. `outcome` is absent only while
 * the run has not ended — an interim turn already leaves a manifest.
 */
export type PublicRunResult =
  | Extract<ResultMeta, { producer: 'backgroundBash' }>
  | (Omit<RunEnd, 'outcome'> & { readonly outcome?: RunOutcome });

/**
 * Join a producer record to its run's terminal fact. A background command is
 * its own result: the `run.end` row of the run that launched it says nothing
 * about the command, so that record passes through whole.
 */
export function unwrapResultMeta(
  meta: ResultMeta,
  runEnd: RunEnd | null,
): PublicRunResult {
  if (meta.producer === 'backgroundBash') return meta;
  return { ...(runEnd ?? {}), output: meta.output };
}

/** Wrap a CLI workflow result in the canonical producer record. */
export function buildCliWorkflowResultMeta(
  flowResult: WorkflowFlowResult,
  options: {
    readonly copiedOutput?: string;
    readonly copiedOutputs?: readonly string[];
  } = {},
): Extract<ResultMeta, { producer: 'cliWorkflow' }> {
  return {
    producer: 'cliWorkflow',
    output: flowResult.output,
    ...(options.copiedOutput !== undefined && {
      copiedOutput: options.copiedOutput,
    }),
    ...(options.copiedOutputs !== undefined && {
      copiedOutputs: [...options.copiedOutputs],
    }),
  };
}
