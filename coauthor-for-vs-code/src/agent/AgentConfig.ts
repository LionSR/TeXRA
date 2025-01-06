// Local imports - agent components
import { ToolConfig } from './ToolConfig';

/**
 * Default configuration for task execution and tool usage
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: 'sonnet+',
  reflect: false,
  agent: '',
  instruction: '',
  inputFile: '',
  inputFiles: [],
  referenceFile: null,
  referenceFiles: [],
  auxiliaryFile: null,
  auxiliaryFiles: [],
  figureFile: null,
  figureFiles: [],
  outputFiles: null,
  outputNameOverride: null,
  editedFile: null,
  toolConfig: {} as ToolConfig,
};

/** Configuration interface for controlling agent execution and file handling. */
export interface AgentConfig {
  // Core configuration
  model: string;
  reflect: boolean;
  agent: string;
  instruction: string;

  // Input/Output configuration
  inputFile: string;
  inputFiles: string[] | null;
  referenceFile: string | null;
  referenceFiles: string[] | null;
  auxiliaryFile: string | null;
  auxiliaryFiles: string[] | null;
  figureFile: string | null;
  figureFiles: string[] | null;
  outputFiles: string[] | null;
  outputNameOverride: string | null;
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
  // Merge provided config with defaults
  return { ...DEFAULT_AGENT_CONFIG, ...config };
}

/**
 * Validates agent configuration for consistency and correctness.
 * @throws Error if output file count exceeds input file count
 */
export function validateAgentConfig(config: AgentConfig): void {
  // For multiple output agents
  if (config.outputFiles) {
    const allInputFiles = [config.inputFile, ...(config.inputFiles || [])];
    if (config.outputFiles.length > allInputFiles.length) {
      throw new Error(
        'Number of output files must not be greater than the number of input files.',
      );
    }
  }
}
