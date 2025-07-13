// Local imports - agent components
import { ToolConfig, ToolConfigSchema } from './ToolConfig';
import { z } from 'zod';

/** Configuration interface for controlling agent execution and file handling. */
export interface AgentConfig {
  // Core configuration
  model: string;
  agent: string;
  instruction: string;

  // Input/Output configuration
  inputFile: string;
  inputFiles: string[] | null;
  referenceFile: string | null;
  referenceFiles: string[] | null;
  auxiliaryFile: string | null;
  auxiliaryFiles: string[] | null;
  mediaFile: string | null;
  mediaFiles: string[] | null;
  outputFiles: string[] | null;
  editedFile: string | null;

  // Tool configuration
  toolConfig: ToolConfig;
}

/**
 * Creates a complete AgentConfig by merging partial config with defaults.
 * @param config Partial configuration to merge with defaults
 * @returns Complete AgentConfig with all fields populated
 */
export function createAgentConfig(config: Partial<AgentConfig>): AgentConfig {
  return AgentConfigSchema.parse(config);
}

/**
 * Checks that the number of output files does not exceed the number of input files.
 * Extracted as a separate function for clarity and reusability.
 */
export const validateOutputFiles = (cfg: AgentConfig): boolean => {
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

    toolConfig: ToolConfigSchema.default({}),
  })
  .strict()
  .refine(validateOutputFiles, {
    message:
      'Number of output files must not be greater than the number of input files.',
    path: ['outputFiles'],
  });
