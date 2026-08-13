import { z } from 'zod';

import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import { NullableFileFieldsSchema } from '@shared/schemas/fileFields';
import { AgentSourceSchema, AgentCategory } from '@shared/schemas/agent';
import { AgentDelegationScopeSchema } from '@shared/schemas/agentRoster';
import { ToolConfigSchema } from '@shared/schemas/toolConfig';

/** Agent assumed when a config omits `agent`, and sorted first in the workflow dropdown. */
export const DEFAULT_WORKFLOW_AGENT = 'correct';

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
  /** CLI-only workspace copy target for `texra run --output`, preserved for resume. */
  cliOutputFile: z.string().nullish(),
  /** CLI-only workspace copy directory for `texra run --output-dir`. */
  cliOutputDirectory: z.string().nullish(),
  /** Relative artifacts expected under {@link cliOutputDirectory}. */
  cliExpectedOutputFiles: z.array(z.string()).nullish(),
  /**
   * Team preset id this execution was launched from (`texra multi-agent run
   * <preset>` in the CLI; the main-view launcher also sets it for team runs so
   * resume retains team identity). Used so a team run — whose root is an
   * orchestrator agent — is not inferred as the default agent for a plain
   * `texra chat` session. Preserved across resume.
   */
  cliMultiAgentPresetId: z.string().nullish(),
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

/**
 * Materialize the absent-category default before the discriminated union
 * selects a variant.
 */
function normalizeAgentConfigInput(input: unknown): unknown {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    ('agentCategory' in input && input.agentCategory !== undefined)
  ) {
    return input;
  }
  return { ...input, agentCategory: AgentCategory.Workflow };
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
 * Wrapped in `z.preprocess` so old execution records persisted before
 * the reference/auxiliary → context rename keep parsing on read.
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
