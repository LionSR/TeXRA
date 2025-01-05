// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';

// Third-party imports
// (none needed)

// Local imports - log
import * as logger from '../logger/logUtils';
import { getConfig } from '../frontend-utils/commonUtils';

// Local imports - agent components
import { AgentConfig, createAgentConfig } from './AgentConfig';
import { AgentSetting, AgentPrompt } from './AgentDataclass';
import { loadAgentSettingAndPrompts } from './agentLoad';
import { ModelConfig } from './ModelConfig';
import { MODEL_CONFIGS } from './ModelRegistry';
import { ModelFactory } from './ModelFactory';
import { DirectAgent } from './DirectAgent';
import { CoTAgent } from './CoTAgent';

const CHANNEL = 'ExecuteAgent';
logger.initializeLogging(CHANNEL);

type AgentConstructor = new (
  modelHandler: any,
  agentConfig: AgentConfig,
  agentSetting: AgentSetting,
  agentPrompt: AgentPrompt,
  agentPath: string,
) => DirectAgent | CoTAgent;

/**
 * Find and return the path to agent's yaml configuration file.
 */
async function getAgentPath(
  agentName: string,
  context: vscode.ExtensionContext,
): Promise<string> {
  try {
    const rootPath = getConfig<string>('explorer.rootPath', 'agents');
    const agentsDir = path.join(context.globalStorageUri.fsPath, rootPath);

    // First try direct path
    const directPath = path.join(agentsDir, `${agentName}.yaml`);
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(directPath));
      return agentsDir;
    } catch {
      // If direct path doesn't exist, try nested path
      const nestedPath = path.join(agentsDir, agentName, `${agentName}.yaml`);
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(nestedPath));
        return path.join(agentsDir, agentName);
      } catch {
        const errorMsg = `Could not find yaml file for agent: ${agentName}`;
        logger.error(CHANNEL, `${errorMsg} from ${agentsDir}`);
        throw new Error(errorMsg);
      }
    }
  } catch (err) {
    const errorMsg = `Error finding agent path: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(CHANNEL, errorMsg);
    throw new Error(errorMsg);
  }
}

/**
 * Get agent class based on settings.
 */
async function getAgentClass(
  agentPath: string,
  agent: string,
  context: vscode.ExtensionContext,
): Promise<AgentConstructor> {
  const [settings] = await loadAgentSettingAndPrompts(
    agentPath,
    agent,
    context,
  );
  return settings.agentType === 'direct' ? DirectAgent : CoTAgent;
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
      context,
    );

    // Get appropriate agent class and create instance
    const AgentClass = await getAgentClass(agentPath, agentName, context);
    const agent = new AgentClass(
      modelHandler,
      fullConfig,
      agentSetting,
      agentPrompt,
      agentPath,
    );

    // Run the agent
    await agent.run();
  } catch (err) {
    const errorMsg = `Error executing agent: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(CHANNEL, errorMsg);
    throw new Error(errorMsg);
  }
}
