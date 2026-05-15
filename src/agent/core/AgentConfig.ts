import { z } from 'zod';

import {
  NullableFileFieldsSchema,
  migrateLegacyContextFileFields,
} from '@shared/schemas/fileFields';
import { ToolConfigSchema } from '@shared/schemas/toolConfig';
import { AgentCategory } from './AgentDataclass';

export const DEFAULT_AGENT_NAME = 'correct';
export const DEFAULT_AGENT_MODEL = 'gemini31p';
export const DEFAULT_AGENT_INSTRUCTION = '';

/** Pure object schema without refinements for use with .partial(). */
const AgentConfigFieldsSchema = NullableFileFieldsSchema.extend({
  agent: z.string().prefault(DEFAULT_AGENT_NAME),
  model: z.string().prefault(DEFAULT_AGENT_MODEL),
  instruction: z.string().prefault(DEFAULT_AGENT_INSTRUCTION),
  agentCategory: z.enum(AgentCategory).prefault(AgentCategory.Workflow),
  editedFiles: z.array(z.string()).prefault([]),
  toolConfig: ToolConfigSchema,
  /** Memory display paths attached to this delegation (e.g. /memories/conventions.md). */
  memories: z.array(z.string()).prefault([]),
  /** Working directory override for subagent tool calls (e.g. a git worktree). */
  workingDirectory: z.string().nullish(),
});

/**
 * Agent configuration schema with output file count validation.
 * Wrapped in `z.preprocess` so old execution records persisted before
 * the reference/auxiliary → context rename keep parsing on read.
 */
export const AgentConfigSchema = z.preprocess(
  migrateLegacyContextFileFields,
  AgentConfigFieldsSchema.superRefine((config, ctx) => {
    // Validate that output files count doesn't exceed input files count
    if (config.outputFiles.length > 0) {
      const inputCount = 1 + config.inputFiles.length; // inputFile + inputFiles
      if (config.outputFiles.length > inputCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputFiles'],
          message:
            'Number of output files must not be greater than the number of input files.',
        });
      }
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
