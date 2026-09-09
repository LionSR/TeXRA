import { z } from 'zod';

import {
  AgentCategory,
  AgentConfigFieldsSchema,
  WorkflowAgentConfigFieldsSchema,
  ToolUseAgentConfigFieldsSchema,
} from '@shared/schemas';

export { DEFAULT_WORKFLOW_AGENT, type AgentConfigInput } from '@shared/schemas';

/**
 * The pre-nesting flat CLI fields, retired in favor of the `cli` sub-object.
 * Rejected explicitly rather than left to the schema: the config variants are
 * built on `z.object`, which strips unknown keys, so a record still carrying
 * these would otherwise parse into a config with no `cli` at all — losing the
 * output-file contract silently instead of failing.
 */
const RETIRED_FLAT_CLI_FIELDS = [
  'cliOutputFile',
  'cliOutputDirectory',
  'cliExpectedOutputFiles',
  'cliMultiAgentPresetId',
] as const;

/**
 * Materialize the absent-category default before the discriminated union
 * selects a variant, and reject the retired flat CLI fields.
 */
function normalizeAgentConfigInput(
  input: unknown,
  ctx: z.RefinementCtx,
): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
  const retired = RETIRED_FLAT_CLI_FIELDS.filter((name) => name in record);
  if (retired.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `Retired flat CLI fields are no longer read: ${retired.join(', ')}`,
    });
    return z.NEVER;
  }
  if ('agentCategory' in record && record.agentCategory !== undefined) {
    return record;
  }
  return { ...record, agentCategory: AgentCategory.Workflow };
}

/**
 * Agent configuration schema with output file count validation.
 * Wrapped in `z.preprocess` so a record that omits `agentCategory` gets the
 * historical Workflow default materialized before the discriminated union
 * selects a variant.
 */
export const AgentConfigSchema = z.preprocess(
  normalizeAgentConfigInput,
  AgentConfigFieldsSchema,
);

export type AgentConfig = z.output<typeof AgentConfigSchema>;
export const WorkflowAgentConfigSchema = z.preprocess(
  normalizeAgentConfigInput,
  WorkflowAgentConfigFieldsSchema,
);
export const ToolUseAgentConfigSchema = z.preprocess(
  normalizeAgentConfigInput,
  ToolUseAgentConfigFieldsSchema,
);
/** Partial agent configuration accepted before launch-time normalization. */
export type AgentConfigPayload = Partial<AgentConfig> &
  Pick<AgentConfig, 'agent' | 'model'>;
