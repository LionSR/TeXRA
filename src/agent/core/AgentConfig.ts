import { z } from 'zod';

import { AgentCategory } from './AgentDataclass';
import { DEFAULT_TOOL_CONFIG, ToolConfigSchema } from './ToolConfig';

/** Pure object schema without refinements for use with .partial(). */
const AgentConfigFieldsSchema = z.object({
  agent: z.string().prefault('correct'),
  model: z.string().prefault('gemini3p'),
  instruction: z.string().prefault(''),
  useMultipleOutputs: z.boolean().prefault(false),
  inputFile: z.string().prefault(''),
  inputFiles: z.array(z.string()).prefault([]),
  referenceFile: z.string().nullable().prefault(null),
  referenceFiles: z.array(z.string()).prefault([]),
  auxiliaryFile: z.string().nullable().prefault(null),
  auxiliaryFiles: z.array(z.string()).prefault([]),
  mediaFile: z.string().nullable().prefault(null),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  agentCategory: z.enum(AgentCategory).prefault(AgentCategory.Workflow),
  editedFile: z.string().nullable().prefault(null),
  editedFiles: z.array(z.string()).prefault([]),
  toolConfig: ToolConfigSchema.prefault(DEFAULT_TOOL_CONFIG),
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
