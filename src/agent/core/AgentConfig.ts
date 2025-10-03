// Third-party imports
import { z } from 'zod';

// Local imports - agent
// Local imports - agent components
import { AgentSessionKind, AgentType } from './AgentDataclass';
import { DEFAULT_TOOL_CONFIG, ToolConfigSchema } from './ToolConfig';

/**
 * Checks that the number of output files does not exceed the number of input files.
 * Extracted as a separate function for clarity and reusability.
 */
export const validateOutputFiles = (cfg: Record<string, any>): boolean => {
  if (cfg.outputFiles) {
    const inputs = [cfg.inputFile, ...(cfg.inputFiles || [])];
    return cfg.outputFiles.length <= inputs.length;
  }
  return true;
};

/** Zod schema for validating AgentConfig objects */
export const AgentConfigSchema = z
  .object({
    model: z.string().default('gemini25p'),
    agent: z.string().default('correct'),
    instruction: z.string().default(''),
    useMultipleOutputs: z.boolean().default(false),

    agentType: z.nativeEnum(AgentType).optional(),
    agentSessionKind: z.nativeEnum(AgentSessionKind).optional(),

    inputFile: z.string().default(''),
    inputFiles: z.array(z.string()).nullable().default(null),
    referenceFile: z.string().nullable().default(null),
    referenceFiles: z.array(z.string()).nullable().default(null),
    auxiliaryFile: z.string().nullable().default(null),
    auxiliaryFiles: z.array(z.string()).nullable().default(null),
    mediaFile: z.string().nullable().default(null),
    mediaFiles: z.array(z.string()).nullable().default(null),
    outputFiles: z.array(z.string()).nullable().default(null),
    editedFile: z.string().nullable().default(null),

    toolConfig: ToolConfigSchema.default(DEFAULT_TOOL_CONFIG),
  })
  // Strip unknown keys to tolerate stale settings from previous releases.
  .strip()
  .refine(validateOutputFiles, {
    message:
      'Number of output files must not be greater than the number of input files.',
    path: ['outputFiles'],
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
