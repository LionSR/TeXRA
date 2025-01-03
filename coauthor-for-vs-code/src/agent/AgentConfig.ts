import { ToolConfig } from './ToolConfig';

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
  // Default configuration
  const defaultConfig: AgentConfig = {
    model: 'sonnet+',
    reflect: false,
    agent: '',
    inputFile: '',
    inputFiles: [],
    referenceFile: null,
    referenceFiles: [],
    auxiliaryFile: null,
    auxiliaryFiles: [],
    figureFile: null,
    figureFiles: [],
    instruction: '',
    outputFiles: null,
    outputNameOverride: null,
    editedFile: null,
    toolConfig: {} as ToolConfig,
  };

  // Merge provided config with defaults
  return { ...defaultConfig, ...config };
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
