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
 * Default configuration for task execution and tool usage
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: 'gemini25p',
  agent: 'correct',
  instruction: '',
  inputFile: '',
  inputFiles: [],
  referenceFile: null,
  referenceFiles: [],
  auxiliaryFile: null,
  auxiliaryFiles: [],
  mediaFile: null,
  mediaFiles: [],
  outputFiles: null,
  editedFile: null,
  toolConfig: {
    reflect: false,
    usePrefillFromInput: false,
    autoExtractFigure: false,
    autoExtractTikzFigure: false,
    attachTeXCount: false,
    printInputPrompt: false,
    autoCompileInputPdf: false,
  },
};

/**
 * Creates a complete AgentConfig by merging partial config with defaults.
 * @param config Partial configuration to merge with defaults
 * @returns Complete AgentConfig with all fields populated
 */
export function createAgentConfig(config: Partial<AgentConfig>): AgentConfig {
  // Merge provided config with defaults, ensuring nested toolConfig is merged deeply
  const mergedToolConfig: ToolConfig = {
    ...DEFAULT_AGENT_CONFIG.toolConfig,
    ...(config.toolConfig ?? {}),
  };

  return {
    ...DEFAULT_AGENT_CONFIG,
    ...config,
    toolConfig: mergedToolConfig,
  };
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
export const AgentConfigSchema: z.ZodSchema<AgentConfig> = z
  .object({
    model: z.string(),
    agent: z.string(),
    instruction: z.string(),

    inputFile: z.string(),
    inputFiles: z.array(z.string()).nullable().optional(),
    referenceFile: z.string().nullable().optional(),
    referenceFiles: z.array(z.string()).nullable(),
    auxiliaryFile: z.string().nullable(),
    auxiliaryFiles: z.array(z.string()).nullable(),
    mediaFile: z.string().nullable(),
    mediaFiles: z.array(z.string()).nullable(),
    outputFiles: z.array(z.string()).nullable(),
    editedFile: z.string().nullable(),

    toolConfig: ToolConfigSchema,
  })
  .strict()
  .refine(
    validateOutputFiles,
    {
      message:
        'Number of output files must not be greater than the number of input files.',
      path: ['outputFiles'],
    },
  );
