// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';
import { glob } from 'glob';

// Third-party imports
// (none needed)

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getAgentsDirectory } from '../utils/pathUtils';

// Local imports - agent components
import { AgentConfig, createAgentConfig } from './AgentConfig';
import { AgentSetting, AgentPrompt } from './AgentDataclass';
import { loadAgentSettingAndPrompts } from './agentLoad';
import { MODEL_CONFIGS } from './ModelRegistry';
import { ModelFactory } from './ModelFactory';
import { DirectAgent } from './DirectAgent';
import { CoTAgent } from './CoTAgent';

const CHANNEL = 'Agent';
logger.initialize(CHANNEL);

type AgentConstructor = {
  new (
    modelHandler: any,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ): DirectAgent | CoTAgent;
};

/**
 * Find and return the path to agent's yaml configuration file.
 */
export async function getAgentPath(
  agentName: string,
  context: vscode.ExtensionContext,
): Promise<string> {
  try {
    const basePath = await getAgentsDirectory(context);

    // Use glob to find the yaml file recursively
    const matches = await glob(`**/${agentName}.yaml`, {
      cwd: basePath,
      dot: false,
      nodir: true,
      absolute: false,
    });

    if (matches.length === 0) {
      const errorMsg = `Could not find yaml file for agent: ${agentName}`;
      logger.error(CHANNEL, `${errorMsg} from ${basePath}`);
      throw new Error(errorMsg);
    }

    // Return the directory containing the yaml file
    return path.join(basePath, path.dirname(matches[0]));
  } catch (err) {
    const errorMsg = `Error finding agent path: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(CHANNEL, errorMsg);
    throw new Error(errorMsg);
  }
}

/**
 * Get agent class based on settings.
 */
function getAgentClass(settings: AgentSetting): AgentConstructor {
  const agentTypeMapping: Record<string, AgentConstructor> = {
    direct: DirectAgent,
    CoT: CoTAgent,
  };
  return agentTypeMapping[settings.agentType] || DirectAgent;
}

/**
 * Get agent name with optional multiple suffix.
 */
function getAgentName(baseAgent: string, outputFiles: string[] | null): string {
  return outputFiles ? `${baseAgent}_multiple` : baseAgent;
}

/**
 * Run the specified agent with given configuration.
 */
export async function executeAgent(
  agentConfig: Partial<AgentConfig>,
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // Ensure required fields
    if (!agentConfig.model || !agentConfig.agent) {
      throw new Error('Missing required fields: model and/or agent');
    }

    // Create full agent config
    const fullConfig = createAgentConfig(agentConfig);

    // Get model configuration
    const modelName = fullConfig.model;
    if (!(modelName in MODEL_CONFIGS)) {
      throw new Error(`Model ${modelName} not found in MODEL_CONFIGS`);
    }

    const modelConfig = MODEL_CONFIGS[modelName];
    // Only override useOpenRouter if it's not already True in the model config
    if (!modelConfig.useOpenRouter) {
      modelConfig.useOpenRouter = fullConfig.toolConfig.useOpenRouter;
    }

    // Create model handler
    const modelHandler = ModelFactory.createHandler(modelConfig);

    // Get agent name and path
    const agentName = getAgentName(fullConfig.agent, fullConfig.outputFiles);
    const agentPath = await getAgentPath(fullConfig.agent, context);

    // Load settings and prompts
    const [agentSetting, agentPrompt] = await loadAgentSettingAndPrompts(
      agentPath,
      agentName,
    );

    // Get appropriate agent class and create instance
    const AgentClass = getAgentClass(agentSetting);
    const agent = new AgentClass(
      modelHandler,
      fullConfig,
      agentSetting,
      agentPrompt,
      agentPath,
    );

    // Initialize agent
    await agent.init();

    // Run the agent
    await agent.run();
  } catch (err) {
    const errorMsg = `Error executing agent: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(CHANNEL, errorMsg);
    throw new Error(errorMsg);
  }
}
