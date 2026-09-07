import { z } from 'zod';

import {
  AgentCategory,
  AgentConfigFieldsSchema,
  WorkflowAgentConfigFieldsSchema,
  ToolUseAgentConfigFieldsSchema,
} from '@shared/schemas';

export { DEFAULT_WORKFLOW_AGENT, type AgentConfigInput } from '@shared/schemas';

const LEGACY_CLI_FIELD_NAMES = [
  'cliOutputFile',
  'cliOutputDirectory',
  'cliExpectedOutputFiles',
  'cliMultiAgentPresetId',
] as const;

/**
 * Move the pre-nesting flat `cli*` fields into the `cli` sub-object once, at
 * the schema entrance, so downstream code only ever sees the nested shape.
 * A no-op once a `cli` object is already present, or when none of the legacy
 * fields are.
 *
 * Introduced 2026-08-28. Retire three months after this ships (see AGENTS.md
 * "Compatibility and format retirement"): once no execution on disk still
 * predates it, delete this function, `LEGACY_CLI_FIELD_NAMES`, and the
 * migration branch in {@link normalizeAgentConfigInput}.
 */
function migrateLegacyCliFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  if ('cli' in input && input.cli != null) return input;
  if (!LEGACY_CLI_FIELD_NAMES.some((name) => name in input)) return input;

  const {
    cliOutputFile,
    cliOutputDirectory,
    cliExpectedOutputFiles,
    cliMultiAgentPresetId,
    ...rest
  } = input as Record<string, unknown>;
  return {
    ...rest,
    cli: {
      outputFile: cliOutputFile,
      outputDirectory: cliOutputDirectory,
      expectedOutputFiles: cliExpectedOutputFiles,
      multiAgentPresetId: cliMultiAgentPresetId,
    },
  };
}

/**
 * Materialize the absent-category default before the discriminated union
 * selects a variant, and migrate legacy flat CLI fields into `cli`.
 */
function normalizeAgentConfigInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const migrated = migrateLegacyCliFields(input as Record<string, unknown>);
  if ('agentCategory' in migrated && migrated.agentCategory !== undefined) {
    return migrated;
  }
  return { ...migrated, agentCategory: AgentCategory.Workflow };
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
