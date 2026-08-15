import { z } from 'zod';

import {
  ToolUseFlowResultSchema,
  WorkflowFlowResultSchema,
  type AgentFlowCategory,
  type AgentFlowResult,
  type WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
import {
  JsonValueSchema,
  RetryErrorInfoSchema,
  RUN_OUTCOME,
  type RunOutcome,
} from '@shared/schemas';

/** Reference to one persisted workflow diff. */
const ResultDiffSummarySchema = z.strictObject({
  /** Absolute path of the output file the diff belongs to. */
  path: z.string(),
  /** Diff file path relative to the execution run directory. */
  diffRelPath: z.string(),
  /** True when the change ratio exceeded the large-change threshold. */
  largeChange: z.boolean(),
});

export type ResultDiffSummary = z.infer<typeof ResultDiffSummarySchema>;

const CostSchema = z.number().nonnegative().prefault(0);

export const WorkflowAgentFinalResultSchema = WorkflowFlowResultSchema.pick({
  category: true,
  outcome: true,
  outputs: true,
  compileFailures: true,
})
  .extend({
    outputs: WorkflowFlowResultSchema.shape.outputs.prefault(() => []),
    compileFailures: WorkflowFlowResultSchema.shape.compileFailures.prefault(
      () => [],
    ),
    diffs: z.array(ResultDiffSummarySchema).prefault(() => []),
    cost: CostSchema,
    diffsUnavailable: z.string().optional(),
    structured: JsonValueSchema.optional(),
    /**
     * The structured error of a run that ended FAILED, carried on the typed
     * result so chaining consumers read the failure from the artifact itself
     * (the result-only observability contract). Absent on non-failed
     * outcomes; journal entries only ever hold completed results.
     */
    error: RetryErrorInfoSchema.optional(),
  })
  .strict();

const ToolUseAgentFinalResultSchema = ToolUseFlowResultSchema.pick({
  category: true,
  outcome: true,
  response: true,
  files: true,
})
  .extend({
    response: ToolUseFlowResultSchema.shape.response.unwrap().prefault(''),
    files: ToolUseFlowResultSchema.shape.files.unwrap().prefault(() => []),
    cost: CostSchema,
    structured: JsonValueSchema.optional(),
    /** See the workflow member: failed runs carry their structured error. */
    error: RetryErrorInfoSchema.optional(),
  })
  .strict();

/** Stable result returned by any completed agent run. */
export const AgentFinalResultSchema = z.discriminatedUnion('category', [
  WorkflowAgentFinalResultSchema,
  ToolUseAgentFinalResultSchema,
]);

export type AgentFinalResult = z.infer<typeof AgentFinalResultSchema>;

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
    if (result.category === 'workflow') {
      return AgentFinalResultSchema.parse({
        category: result.category,
        outcome,
        outputs: result.outputs,
        compileFailures: result.compileFailures,
        diffs: source.diffs,
        cost: result.totalCostUsd,
        diffsUnavailable: source.diffsUnavailable,
        structured,
        ...error,
      });
    }
    return AgentFinalResultSchema.parse({
      category: result.category,
      outcome,
      response: result.response,
      files: result.files,
      cost: result.totalCostUsd,
      structured,
      ...error,
    });
  }

  return AgentFinalResultSchema.parse(source);
}
