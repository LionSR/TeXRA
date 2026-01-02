// Third-party imports
import { z } from 'zod';

// Local imports - agent components
import { AgentType, resolveAgentSessionDescriptor } from './AgentDataclass';
import { AgentSessionDescriptorSchema } from './AgentSessionSchema';
import { DEFAULT_TOOL_CONFIG, ToolConfigSchema } from './ToolConfig';

/**
 * Checks that the number of output files does not exceed the number of input files.
 * Extracted as a separate function for clarity and reusability.
 */
export const validateOutputFiles = (cfg: {
  inputFile: string;
  inputFiles: string[];
  outputFiles: string[];
}): boolean => {
  if (cfg.outputFiles.length === 0) {
    return true;
  }

  const inputs = [cfg.inputFile, ...cfg.inputFiles];
  return cfg.outputFiles.length <= inputs.length;
};

/** Zod schema for validating AgentConfig objects */
const stringArrayField = () => z.array(z.string()).prefault([]);

const AgentConfigBaseSchema = z
  .object({
    model: z.string().prefault('gemini3p'),
    agent: z.string().prefault('correct'),
    instruction: z.string().prefault(''),
    useMultipleOutputs: z.boolean().prefault(false),

    // Legacy field for backward compatibility - prefer session.agentType
    agentType: z.enum(AgentType).optional(),
    // Canonical session descriptor - single source of truth
    session: AgentSessionDescriptorSchema.optional(),

    inputFile: z.string().prefault(''),
    inputFiles: stringArrayField(),
    referenceFile: z.string().nullable().prefault(null),
    referenceFiles: stringArrayField(),
    auxiliaryFile: z.string().nullable().prefault(null),
    auxiliaryFiles: stringArrayField(),
    mediaFile: z.string().nullable().prefault(null),
    mediaFiles: stringArrayField(),
    outputFiles: stringArrayField(),
    editedFile: z.string().nullable().prefault(null),

    // Defaults to all-false for tool-use agents; workflow agents populate from UI
    toolConfig: ToolConfigSchema.prefault(DEFAULT_TOOL_CONFIG),
  })
  .superRefine((config, ctx) => {
    if (
      !validateOutputFiles({
        inputFile: config.inputFile,
        inputFiles: config.inputFiles,
        outputFiles: config.outputFiles,
      })
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['outputFiles'],
        message:
          'Number of output files must not be greater than the number of input files.',
      });
    }
  });

export const AgentConfigSchema = AgentConfigBaseSchema.transform((config) => {
  const descriptor = resolveAgentSessionDescriptor(
    config.session?.agentType ?? config.agentType,
    config.session?.agentCategory,
  );

  return {
    ...config,
    agentType: descriptor.agentType,
    session: descriptor,
  };
});

export type AgentConfig = z.output<typeof AgentConfigSchema>;
export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
