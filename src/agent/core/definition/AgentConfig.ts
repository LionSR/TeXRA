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

/** Pure object schema without refinements for use with .partial(). */
const AgentConfigFieldsSchema = NullableFileFieldsSchema.extend({
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
  agentCategory: z.enum(AgentCategory).prefault(AgentCategory.Workflow),
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

/**
 * Agent configuration schema with output file count validation.
 * Wrapped in `z.preprocess` so old execution records persisted before
 * the reference/auxiliary → context rename keep parsing on read.
 */
export const AgentConfigSchema = z.preprocess(
  migrateLegacyContextFileFields,
  AgentConfigFieldsSchema.superRefine((config, ctx) => {
    // Output files must not outnumber input files.
    if (config.outputFiles.length > config.inputFiles.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputFiles'],
        message:
          'Number of output files must not be greater than the number of input files.',
      });
    }
  }),
);

export type AgentConfig = z.output<typeof AgentConfigSchema>;
export type AgentConfigInput = z.input<typeof AgentConfigFieldsSchema>;

/** Agent configuration payload with required agent and model fields. */
const AgentConfigPayloadSchema = AgentConfigFieldsSchema.partial().required({
  agent: true,
  model: true,
});

export type AgentConfigPayload = z.infer<typeof AgentConfigPayloadSchema>;
