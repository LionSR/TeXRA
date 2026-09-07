/** Shared canonical configuration schema for runtime and persisted events. */
import { z } from 'zod';

import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import { AgentCategory, AgentSourceSchema } from './agent';
import { AgentDelegationScopeSchema } from './agentRoster';
import { NullableFileFieldsSchema } from './fileFields';
import { ToolConfigSchema } from './toolConfig';

/** Agent selected when launch input omits its workflow agent. */
export const DEFAULT_WORKFLOW_AGENT = 'correct';

/**
 * CLI-only fields, grouped so the CLI-specific footprint of `AgentConfig`
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

const workflowFields = AgentConfigSharedFieldsSchema.extend({
  agentCategory: z.literal(AgentCategory.Workflow),
});

const toolUseFields = AgentConfigSharedFieldsSchema.extend({
  agentCategory: z.literal(AgentCategory.ToolUse),
  /**
   * JSON Schema (a plain object) describing a structured output the agent must
   * submit through the synthetic `submit_output` terminal tool. Serializable by
   * design: a live Zod schema or ITool must never travel through config. Absent
   * for ordinary tool-use runs.
   */
  outputSchema: z.record(z.string(), z.unknown()).nullish(),
});

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

/** Canonical current configuration; legacy input normalization belongs to the launcher. */
export const WorkflowAgentConfigFieldsSchema = workflowFields.superRefine(
  validateOutputFileCount,
);
export const ToolUseAgentConfigFieldsSchema = toolUseFields.superRefine(
  validateOutputFileCount,
);
export const AgentConfigFieldsSchema = z.discriminatedUnion('agentCategory', [
  WorkflowAgentConfigFieldsSchema,
  ToolUseAgentConfigFieldsSchema,
]);
export type AgentConfigInput = z.input<typeof AgentConfigSharedFieldsSchema> & {
  agentCategory?: AgentCategory;
};
