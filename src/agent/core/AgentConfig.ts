// Local imports - agent components
import { ToolConfig, ToolConfigSchema } from './ToolConfig';
// Third-party imports
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

/** Zod schema for ToolConfig */
export const AgentConfigSchema = z
  .object({
    model: z.string(),
    agent: z.string(),
    instruction: z.string(),
    inputFile: z.string(),
    inputFiles: z.array(z.string()).nullable(),
    referenceFile: z.string().nullable(),
    referenceFiles: z.array(z.string()).nullable(),
    auxiliaryFile: z.string().nullable(),
    auxiliaryFiles: z.array(z.string()).nullable(),
    mediaFile: z.string().nullable(),
    mediaFiles: z.array(z.string()).nullable(),
    outputFiles: z.array(z.string()).nullable(),
    editedFile: z.string().nullable(),
    toolConfig: ToolConfigSchema,
  })
  .refine(
    (cfg) =>
      !cfg.outputFiles ||
      cfg.outputFiles.length <=
        [cfg.inputFile, ...(cfg.inputFiles || [])].length,
    {
      message:
        'Number of output files must not be greater than the number of input files.',
      path: ['outputFiles'],
    },
  );

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
  toolConfig: {} as ToolConfig,
};

/**
 * Creates a complete AgentConfig by merging partial config with defaults.
 * @param config Partial configuration to merge with defaults
 * @returns Complete AgentConfig with all fields populated
 */
export function createAgentConfig(config: Partial<AgentConfig>): AgentConfig {
  // Merge provided config with defaults
  return { ...DEFAULT_AGENT_CONFIG, ...config };
}

/**
 * Validates agent configuration for consistency and correctness.
 * @throws Error if output file count exceeds input file count
 */
export function validateAgentConfig(config: AgentConfig): void {
  AgentConfigSchema.parse(config);
}
