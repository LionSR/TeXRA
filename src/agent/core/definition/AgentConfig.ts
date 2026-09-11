import { z } from 'zod';

import {
  AgentCategory,
  AgentConfigFieldsSchema,
  WorkflowAgentConfigFieldsSchema,
  ToolUseAgentConfigFieldsSchema,
} from '@shared/schemas';

/**
 * Materialize the absent-category default before the discriminated union
 * selects a variant.
 */
function normalizeAgentConfigInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
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
