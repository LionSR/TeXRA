// Local imports - agent components
import { ToolConfig } from './ToolConfig';
import type { AgentConfigId, WithEntityId, CreatableEntity, generateEntityId } from '../../types/EntityTypes';

/** Configuration interface for controlling agent execution and file handling. */
export interface AgentConfig extends WithEntityId<AgentConfigId> {
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
 * Default configuration template for task execution and tool usage
 */
const DEFAULT_AGENT_CONFIG_TEMPLATE: Omit<AgentConfig, 'id'> = {
  model: 'sonnet37',
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
  // Generate ID if not provided
  const id = config.id || generateEntityId<AgentConfigId>();
  
  // Merge provided config with defaults
  return { 
    id,
    ...DEFAULT_AGENT_CONFIG_TEMPLATE, 
    ...config 
  };
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
