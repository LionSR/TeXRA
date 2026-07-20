import { z } from 'zod';

import {
  AgentFinalResultSchema,
  ResultDiffSummarySchema,
  WorkflowAgentFinalResultSchema,
  buildAgentFinalResult,
  projectToolUseFinalTextFields,
  type AgentFinalResult,
} from '@agent/runtime/AgentFinalResult';
import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import {
  ExecutionIdSchema,
  RUN_OUTCOME,
  RunOutcomeSchema,
  type RunOutcome,
} from '@shared/schemas';
import {
  CompileFailureSummarySchema,
  OutputFileSummarySchema,
} from '@shared/schemas/output';

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
});

/** Canonical persisted result record. Legacy shapes are read separately. */
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

const LegacyAgentResultFieldsSchema = z.strictObject({
  category: z.enum(['workflow', 'toolUse']).optional(),
  outcome: RunOutcomeSchema.optional(),
  outputs: z.array(OutputFileSummarySchema).optional(),
  compileFailures: z.array(CompileFailureSummarySchema).optional(),
  diffs: z.array(ResultDiffSummarySchema).optional(),
  diffsUnavailable: z.string().optional(),
  response: z.string().optional(),
  lastResponse: z.string().optional(),
  files: z.array(z.string()).optional(),
  touchedFiles: z.array(z.string()).optional(),
  cost: z.number().nonnegative().optional(),
  totalCostUsd: z.number().nonnegative().optional(),
});

type LegacyAgentResultFields = z.infer<typeof LegacyAgentResultFieldsSchema>;

const LegacyBackgroundBashResultMetaSchema = z.strictObject({
  producer: z.literal('backgroundBash').optional(),
  exitCode: z.int().optional(),
  wallTimeMs: z.number().nonnegative(),
  success: z.boolean(),
  timedOut: z.boolean().optional(),
  command: z.string(),
});

const LegacySubagentResultMetaSchema = LegacyAgentResultFieldsSchema.extend({
  producer: z.literal('subagent').optional(),
  agentName: z.string(),
  wallTimeMs: z.number().nonnegative(),
  success: z.boolean().optional(),
  result: LegacyAgentResultFieldsSchema.optional(),
});

const LegacyCliWorkflowResultMetaSchema = LegacyAgentResultFieldsSchema.extend({
  producer: z.literal('cliWorkflow').optional(),
  success: z.boolean().optional(),
  copiedOutput: z.string().optional(),
  copiedOutputs: z.array(z.string()).optional(),
  result: LegacyAgentResultFieldsSchema.extend({
    copiedOutput: z.string().optional(),
    copiedOutputs: z.array(z.string()).optional(),
  }).optional(),
}).refine(
  (meta) =>
    meta.category !== 'toolUse' &&
    meta.result?.category !== 'toolUse' &&
    (meta.producer === 'cliWorkflow' ||
      meta.outputs !== undefined ||
      meta.compileFailures !== undefined ||
      meta.diffs !== undefined ||
      meta.diffsUnavailable !== undefined ||
      meta.copiedOutput !== undefined ||
      meta.copiedOutputs !== undefined ||
      meta.result !== undefined),
  { message: 'legacy CLI result metadata is not a workflow result' },
);

const LegacyPersistedResultMetaSchema = z.union([
  LegacyBackgroundBashResultMetaSchema.transform((meta) => ({
    kind: 'backgroundBash' as const,
    meta,
  })),
  LegacySubagentResultMetaSchema.transform((meta) => ({
    kind: 'subagent' as const,
    meta,
  })),
  LegacyCliWorkflowResultMetaSchema.transform((meta) => ({
    kind: 'cliWorkflow' as const,
    meta,
  })),
]);

type ResultMetaReadContext = {
  readonly category?: AgentFinalResult['category'];
  readonly outcome?: RunOutcome;
};

function resolveStoredFact<T extends string>(
  name: string,
  nested: T | undefined,
  outer: T | undefined,
): T | undefined {
  if (nested !== undefined && outer !== undefined && nested !== outer) {
    throw new Error(`Conflicting legacy result ${name} values.`);
  }
  return nested ?? outer;
}

function inferCategory(
  outer: LegacyAgentResultFields,
  nested: LegacyAgentResultFields | undefined,
  fallback: AgentFinalResult['category'] | undefined,
): AgentFinalResult['category'] | undefined {
  const explicit = resolveStoredFact(
    'category',
    nested?.category,
    outer.category,
  );
  if (explicit) return explicit;

  const records = [outer, nested].filter(
    (record): record is LegacyAgentResultFields => record !== undefined,
  );
  const hasWorkflowFields = records.some(
    (record) =>
      record.outputs !== undefined ||
      record.compileFailures !== undefined ||
      record.diffs !== undefined ||
      record.diffsUnavailable !== undefined,
  );
  const hasToolUseFields = records.some(
    (record) =>
      record.response !== undefined ||
      record.lastResponse !== undefined ||
      record.files !== undefined ||
      record.touchedFiles !== undefined,
  );
  if (hasWorkflowFields && hasToolUseFields) {
    throw new Error(
      'Legacy result contains both workflow and tool-use fields.',
    );
  }
  if (hasWorkflowFields) return 'workflow';
  if (hasToolUseFields) return 'toolUse';
  return fallback;
}

function resolveOutcome(
  outer: LegacyAgentResultFields & { success?: boolean },
  nested: LegacyAgentResultFields | undefined,
  fallback: RunOutcome | undefined,
): RunOutcome | undefined {
  const explicit = resolveStoredFact('outcome', nested?.outcome, outer.outcome);
  if (explicit) return explicit;
  if (outer.success === true) return RUN_OUTCOME.COMPLETED;
  if (outer.success === false) return RUN_OUTCOME.FAILED;
  return fallback;
}

function requireLegacyFact<T>(value: T | undefined, description: string): T {
  if (value === undefined) {
    throw new Error(`Legacy result has no trustworthy ${description}.`);
  }
  return value;
}

function buildLegacyAgentFinalResult(
  category: AgentFinalResult['category'],
  outcome: RunOutcome,
  outer: LegacyAgentResultFields,
  nested: LegacyAgentResultFields | undefined,
): AgentFinalResult {
  const cost =
    nested?.cost ?? nested?.totalCostUsd ?? outer.cost ?? outer.totalCostUsd;
  if (category === 'workflow') {
    return AgentFinalResultSchema.parse({
      category,
      outcome,
      outputs: nested?.outputs ?? outer.outputs,
      compileFailures: nested?.compileFailures ?? outer.compileFailures,
      diffs: nested?.diffs ?? outer.diffs,
      diffsUnavailable: nested?.diffsUnavailable ?? outer.diffsUnavailable,
      cost,
    });
  }
  return AgentFinalResultSchema.parse({
    category,
    outcome,
    ...projectToolUseFinalTextFields(nested, outer),
    cost,
  });
}

/** Parse a canonical record or normalize one historical persisted shape. */
export function parsePersistedResultMeta(
  raw: unknown,
  context: ResultMetaReadContext,
): ResultMeta {
  const canonical = ResultMetaSchema.safeParse(raw);
  if (canonical.success) return canonical.data;

  const legacy = LegacyPersistedResultMetaSchema.parse(raw);
  if (legacy.kind === 'backgroundBash') {
    return ResultMetaSchema.parse({
      ...legacy.meta,
      producer: 'backgroundBash',
    });
  }

  if (legacy.kind === 'subagent') {
    const category = requireLegacyFact(
      inferCategory(legacy.meta, legacy.meta.result, context.category),
      'agent category',
    );
    const outcome = requireLegacyFact(
      resolveOutcome(legacy.meta, legacy.meta.result, context.outcome),
      'run outcome',
    );
    return ResultMetaSchema.parse({
      producer: 'subagent',
      agentName: legacy.meta.agentName,
      wallTimeMs: legacy.meta.wallTimeMs,
      result: buildLegacyAgentFinalResult(
        category,
        outcome,
        legacy.meta,
        legacy.meta.result,
      ),
    });
  }

  // Before the envelope contract, the CLI workflow writer persisted a result
  // only after output resolution succeeded. Those historical records carried
  // no outcome field, so their existence is itself a trustworthy completion
  // signal when neither the record nor execution metadata supplies one.
  const outcome =
    resolveOutcome(legacy.meta, legacy.meta.result, context.outcome) ??
    RUN_OUTCOME.COMPLETED;
  return ResultMetaSchema.parse({
    producer: 'cliWorkflow',
    result: buildLegacyAgentFinalResult(
      'workflow',
      outcome,
      legacy.meta,
      legacy.meta.result,
    ),
    copiedOutput: legacy.meta.copiedOutput ?? legacy.meta.result?.copiedOutput,
    copiedOutputs:
      legacy.meta.copiedOutputs ?? legacy.meta.result?.copiedOutputs,
  });
}
