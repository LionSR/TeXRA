// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';
import { glob } from 'glob';

// Third-party imports
// (none needed)

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
import { MergeAgent } from './MergeAgent';
import { LogViewProvider } from '../logger/LogViewProvider';

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
      vscode.window.showErrorMessage(`${errorMsg} from ${basePath}`);
      throw new Error(errorMsg);
    }

    // Return the directory containing the yaml file
    return path.join(basePath, path.dirname(matches[0]));
  } catch (err) {
    const errorMsg = `Error finding agent path: ${err instanceof Error ? err.message : String(err)}`;
    vscode.window.showErrorMessage(errorMsg);
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
function getAgentName(baseAgent: string, outputFiles: string[] | null | undefined): string {
  if (outputFiles && outputFiles.length > 1) {
    // logger.info(CHANNEL, `Switching to multiple output mode`);
    return `${baseAgent}_multiple`;
  }
  return baseAgent;
}

/**
 * Common function to execute any agent with proper logging and status handling
 */
async function executeAgentWithLogging<T extends DirectAgent | CoTAgent | MergeAgent>(
  agentName: string,
  createAgentFn: () => Promise<T>,
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // Get logger instance
    const logViewProvider = LogViewProvider.getInstance();
    if (!logViewProvider) {
      throw new Error('LogViewProvider not initialized');
    }
    
    // Update status to running
    logViewProvider.updateStreamStatus(agentName, 'running');

    // Create and initialize agent
    const agent = await createAgentFn();
    await agent.init();

    try {
      // Run the agent
      await agent.run();
      // Update status to stopped on successful completion
      logViewProvider.updateStreamStatus(agentName, 'stopped');
    } catch (err) {
      // Update status to error if agent run fails
      logViewProvider.updateStreamStatus(agentName, 'error');
      throw err;
    }
  } catch (err) {
    const errorMsg = `Error executing agent ${agentName}: ${err instanceof Error ? err.message : String(err)}`;
    vscode.window.showErrorMessage(errorMsg);
    throw new Error(errorMsg);
  }
}

export async function executeAgent(
  agentConfig: Partial<AgentConfig>,
  context: vscode.ExtensionContext,
): Promise<void> {
  // Ensure required fields
  if (!agentConfig.model || !agentConfig.agent) {
    throw new Error('Missing required fields: model and/or agent');
  }

  const agentName = getAgentName(agentConfig.agent, agentConfig.outputFiles);
  
  await executeAgentWithLogging(agentName, async () => {
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

    // Get agent path
    const agentPath = await getAgentPath(fullConfig.agent, context);

    // Load settings and prompts
    const [agentSetting, agentPrompt] = await loadAgentSettingAndPrompts(
      agentPath,
      agentName,
    );

    // Get appropriate agent class and create instance
    const AgentClass = getAgentClass(agentSetting);
    return new AgentClass(
      modelHandler,
      fullConfig,
      agentSetting,
      agentPrompt,
      agentPath,
    );
  }, context);
}

/**
 * Run merge agent to handle file merging operations.
 */
export async function executeMergeAgent(
  model: string,
  inputFile: string,
  editedFile: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  const agentName = 'merge';
  
  await executeAgentWithLogging(agentName, async () => {
    // Create agent config for merge operation
    const agentConfig = createAgentConfig({
      agent: 'merge',
      model,
      inputFile,
      editedFile,
    });

    // Get model configuration
    if (!(model in MODEL_CONFIGS)) {
      throw new Error(`Model ${model} not found in MODEL_CONFIGS`);
    }

    const modelConfig = MODEL_CONFIGS[model];
    const modelHandler = ModelFactory.createHandler(modelConfig);

    // Get agent path and load settings/prompts
    const agentPath = await getAgentPath('merge', context);
    const [agentSetting, agentPrompt] = await loadAgentSettingAndPrompts(
      agentPath,
      'merge',
    );

    return new MergeAgent(
      modelHandler,
      agentConfig,
      agentSetting,
      agentPrompt,
      agentPath,
    );
  }, context);
}
