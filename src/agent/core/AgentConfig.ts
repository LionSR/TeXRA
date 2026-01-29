import { z } from 'zod';

import { NullableFileFieldsSchema } from '@shared/schemas/fileFields';
import { ToolConfigSchema } from '@shared/schemas/toolConfig';
import { AgentCategory } from './AgentDataclass';

/** Pure object schema without refinements for use with .partial(). */
const AgentConfigFieldsSchema = NullableFileFieldsSchema.extend({
  agent: z.string().prefault('correct'),
  model: z.string().prefault('gemini3p'),
  instruction: z.string().prefault(''),
  useMultipleOutputs: z.boolean().prefault(false),
  agentCategory: z.enum(AgentCategory).prefault(AgentCategory.Workflow),
  editedFiles: z.array(z.string()).prefault([]),
  toolConfig: ToolConfigSchema,
});

/** Lift legacy session.agentCategory to top level for backward compatibility. */
export function liftLegacyAgentCategory(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;

  if ('agentCategory' in obj && obj.agentCategory !== undefined) {
    return input;
  }

  const session = obj.session as Record<string, unknown> | undefined;
  if (session && 'agentCategory' in session) {
    return { ...obj, agentCategory: session.agentCategory };
  }

  return input;
}

/** Agent configuration schema with output file count validation. */
export const AgentConfigSchema = z.preprocess(
  liftLegacyAgentCategory,
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
export const AgentConfigPayloadSchema = AgentConfigFieldsSchema.partial()
  .required({
    agent: true,
    model: true,
  })
  .describe('Agent configuration payload with required agent and model fields');

export type AgentConfigPayload = z.infer<typeof AgentConfigPayloadSchema>;
