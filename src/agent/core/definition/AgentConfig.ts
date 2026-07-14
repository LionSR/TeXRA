import { z } from 'zod';

import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import {
  NullableFileFieldsSchema,
  migrateLegacyContextFileFields,
} from '@shared/schemas/fileFields';
import { AgentSourceSchema } from '@shared/schemas/agent';
import { AgentDelegationScopeSchema } from '@shared/schemas/agentRoster';
import { ToolConfigSchema } from '@shared/schemas/toolConfig';
import { AgentCategory } from './AgentDataclass';

const DEFAULT_AGENT_NAME = 'correct';
const DEFAULT_AGENT_INSTRUCTION = '';

/** Fields shared by both category-specific config variants. */
const AgentConfigSharedFieldsSchema = NullableFileFieldsSchema.extend({
  agent: z.string().prefault(DEFAULT_AGENT_NAME),
  /**
   * Resolved source of `agent`, captured once when the delegation is validated
   * (`getVisibleAgent`). Launch resolves the exact `(source, name)` entry by key
   * instead of re-resolving the ambiguous bare name, so it lands on the same
   * entry validation picked. Absent for legacy records and direct launches that
   * don't pin a source — those fall back to name-based resolution.
   */
  agentSource: AgentSourceSchema.nullish(),
  model: z.string().prefault(DEFAULT_AGENT_MODEL),
  instruction: z.string().prefault(DEFAULT_AGENT_INSTRUCTION),
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
  /**
   * CLI-only marker: the multi-agent team preset id this execution was launched
   * from (`texra multi-agent run <preset>`). Used so a team run — whose root is
   * an orchestrator agent — is not inferred as the default agent for a plain
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
});

const AgentConfigFieldsSchema = z.discriminatedUnion('agentCategory', [
  WorkflowAgentConfigFieldsSchema,
  ToolUseAgentConfigFieldsSchema,
]);

/**
 * Normalize legacy file fields and materialize the historical absent-category
 * default before the discriminated union selects a variant.
 */
function normalizeAgentConfigInput(input: unknown): unknown {
  const migrated = migrateLegacyContextFileFields(input);
  if (
    typeof migrated !== 'object' ||
    migrated === null ||
    Array.isArray(migrated) ||
    ('agentCategory' in migrated && migrated.agentCategory !== undefined)
  ) {
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
 * Wrapped in `z.preprocess` so old execution records persisted before
 * the reference/auxiliary → context rename keep parsing on read.
 */
export const AgentConfigSchema = z.preprocess(
  normalizeAgentConfigInput,
  AgentConfigFieldsSchema.superRefine(validateOutputFileCount),
);

export type AgentConfig = z.output<typeof AgentConfigSchema>;
export type WorkflowAgentConfig = Extract<
  AgentConfig,
  { agentCategory: typeof AgentCategory.Workflow }
>;
export type ToolUseAgentConfig = Extract<
  AgentConfig,
  { agentCategory: typeof AgentCategory.ToolUse }
>;
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

/** Agent configuration payload with required agent and model fields. */
const AgentConfigPayloadSchema = AgentConfigSharedFieldsSchema.extend({
  agentCategory: z.enum(AgentCategory).optional(),
})
  .partial()
  .required({
    agent: true,
    model: true,
  });

export type AgentConfigPayload = z.infer<typeof AgentConfigPayloadSchema>;
