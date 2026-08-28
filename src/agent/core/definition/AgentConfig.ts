import { z } from 'zod';

import {
  AgentCategory,
  AgentDelegationScopeSchema,
  AgentSourceSchema,
  NullableFileFieldsSchema,
  ToolConfigSchema,
} from '@shared/schemas';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';

/** Agent assumed when a config omits `agent`, and sorted first in the workflow dropdown. */
export const DEFAULT_WORKFLOW_AGENT = 'correct';

/**
 * CLI-only fields, grouped so the CLI-specific footprint of {@link AgentConfig}
 * is self-evident at the schema level. Absent for extension/desktop-launched
 * runs.
 */
const CliOutputFieldsSchema = z.object({
  /** Workspace copy target for `texra run --output`, preserved for resume. */
  outputFile: z.string().nullish(),
  /** Workspace copy directory for `texra run --output-dir`. */
  outputDirectory: z.string().nullish(),
  /** Relative artifacts expected under {@link CliOutputFieldsSchema.outputDirectory}. */
  expectedOutputFiles: z.array(z.string()).nullish(),
  /**
   * Team preset id this execution was launched from (`texra multi-agent run
   * <preset>` in the CLI; the main-view launcher also sets it for team runs so
   * resume retains team identity). Used so a team run — whose root is an
   * orchestrator agent — is not inferred as the default agent for a plain
   * `texra chat` session. Preserved across resume.
   */
  multiAgentPresetId: z.string().nullish(),
});

/** Fields shared by both category-specific config variants. */
const AgentConfigSharedFieldsSchema = NullableFileFieldsSchema.extend({
  agent: z.string().prefault(DEFAULT_WORKFLOW_AGENT),
  /**
   * Resolved source of `agent`, captured once when the delegation is validated
   * (`getVisibleAgent`). Launch resolves the exact `(source, name)` entry by key
   * instead of re-resolving the ambiguous bare name, so it lands on the same
   * entry validation picked. Absent for legacy records and direct launches that
   * don't pin a source — those fall back to name-based resolution.
   */
  agentSource: AgentSourceSchema.nullish(),
  model: z.string().prefault(DEFAULT_AGENT_MODEL),
  instruction: z.string().prefault(''),
  /** Original user instruction preserved across nested tool-use delegation. */
  rootUserInstruction: z.string().nullish(),
  /** Optional user-facing text for logs when instruction contains hidden context. */
  displayInstruction: z.string().nullish(),
  editedFiles: z.array(z.string()).prefault([]),
  toolConfig: ToolConfigSchema,
  /** Memory display paths attached to this delegation (e.g. /memories/conventions.md). */
  memories: z.array(z.string()).prefault([]),
  /** Working directory override for subagent tool calls (e.g. a git worktree). */
  workingDirectory: z.string().nullish(),
  /** CLI-only fields, absent for extension/desktop-launched runs. */
  cli: CliOutputFieldsSchema.nullish(),
  /** Execution-scoped delegation roster used by team runs and their children. */
  delegationAgentScope: AgentDelegationScopeSchema.nullish(),
});

const WorkflowAgentConfigFieldsSchema = AgentConfigSharedFieldsSchema.extend({
  agentCategory: z.literal(AgentCategory.Workflow),
});

const ToolUseAgentConfigFieldsSchema = AgentConfigSharedFieldsSchema.extend({
  agentCategory: z.literal(AgentCategory.ToolUse),
  /**
   * JSON Schema (a plain object) describing a structured output the agent must
   * submit through the synthetic `submit_output` terminal tool. Serializable by
   * design: a live Zod schema or ITool must never travel through config. Absent
   * for ordinary tool-use runs.
   */
  outputSchema: z.record(z.string(), z.unknown()).nullish(),
});

const AgentConfigFieldsSchema = z.discriminatedUnion('agentCategory', [
  WorkflowAgentConfigFieldsSchema,
  ToolUseAgentConfigFieldsSchema,
]);

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
  if ('cli' in input && input.cli !== undefined) return input;
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

function validateOutputFileCount(
  config: z.output<typeof AgentConfigSharedFieldsSchema>,
  ctx: z.RefinementCtx,
): void {
  if (config.outputFiles.length > config.inputFiles.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['outputFiles'],
      message:
        'Number of output files must not be greater than the number of input files.',
    });
  }
}

/**
 * Agent configuration schema with output file count validation.
 * Wrapped in `z.preprocess` so a record that omits `agentCategory` gets the
 * historical Workflow default materialized before the discriminated union
 * selects a variant.
 */
export const AgentConfigSchema = z.preprocess(
  normalizeAgentConfigInput,
  AgentConfigFieldsSchema.superRefine(validateOutputFileCount),
);

export type AgentConfig = z.output<typeof AgentConfigSchema>;
export const WorkflowAgentConfigSchema = z.preprocess(
  normalizeAgentConfigInput,
  WorkflowAgentConfigFieldsSchema.superRefine(validateOutputFileCount),
);
export const ToolUseAgentConfigSchema = z.preprocess(
  normalizeAgentConfigInput,
  ToolUseAgentConfigFieldsSchema.superRefine(validateOutputFileCount),
);
export type AgentConfigInput = z.input<typeof AgentConfigSharedFieldsSchema> & {
  agentCategory?: AgentCategory;
};

/** Partial agent configuration accepted before launch-time normalization. */
export type AgentConfigPayload = Partial<AgentConfig> &
  Pick<AgentConfig, 'agent' | 'model'>;
