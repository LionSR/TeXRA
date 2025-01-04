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

/**
 * Configuration for task execution and tool usage
 */
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
 * Create AgentConfig from partial configuration
 */
export function createAgentConfig(config: Partial<AgentConfig>): AgentConfig {
  // Merge provided config with defaults
  return { ...DEFAULT_AGENT_CONFIG, ...config };
}

/**
 * Validate the configuration
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
