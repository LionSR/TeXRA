import {
  type AgentFlowCategory,
  type AgentFlowResult,
  type WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
import { RUN_OUTCOME, type RunOutcome } from '@shared/schemas';

import {
  AgentFinalResultSchema,
  type AgentFinalResult,
  type ResultDiffSummary,
} from '@shared/schemas';

type AgentFinalResultSource =
  | {
      readonly flowResult: AgentFlowResult;
      readonly outcome?: RunOutcome;
      readonly diffs?: readonly ResultDiffSummary[];
      readonly diffsUnavailable?: string;
      readonly structured?: unknown;
    }
  | {
      readonly category: AgentFlowCategory;
      readonly outcome: RunOutcome;
      readonly structured?: unknown;
    };

/**
 * Build the stable final result after all post-flow artifacts, such as
 * workflow diffs, are available. A category-only source is used when a run
 * fails before producing an AgentFlowResult.
 */
export function buildAgentFinalResult(source: {
  readonly flowResult: WorkflowFlowResult;
  readonly outcome?: RunOutcome;
  readonly diffs?: readonly ResultDiffSummary[];
  readonly diffsUnavailable?: string;
  readonly structured?: unknown;
}): Extract<AgentFinalResult, { category: 'workflow' }>;
export function buildAgentFinalResult(
  source: AgentFinalResultSource,
): AgentFinalResult;
export function buildAgentFinalResult(
  source: AgentFinalResultSource,
): AgentFinalResult {
  if ('flowResult' in source) {
    const result = source.flowResult;
    const outcome = source.outcome ?? result.outcome;
    // Surface the flow result's own captured structured value when the caller
    // did not pass one, so a populated flow result carries `structured` without
    // every caller re-threading it.
    const structured =
      source.structured ??
      (result.category === 'toolUse' ? result.structured : undefined);
    // Error facts travel only with the outcome they describe: a caller that
    // re-stamps a nominally completed flow as failed keeps the flow's error
    // (when it recorded one); any non-failed outcome drops it.
    const error =
      outcome === RUN_OUTCOME.FAILED && result.error !== undefined
        ? { error: result.error }
        : {};
    const common = {
      category: result.category,
      outcome,
      cost: result.totalCostUsd,
      structured,
      ...error,
    };
    if (result.category === 'workflow') {
      return AgentFinalResultSchema.parse({
        ...common,
        outputs: result.outputs,
        compileFailures: result.compileFailures,
        diffs: source.diffs,
        diffsUnavailable: source.diffsUnavailable,
      });
    }
    return AgentFinalResultSchema.parse({
      ...common,
      response: result.response,
      files: result.files,
    });
  }

  return AgentFinalResultSchema.parse(source);
}
