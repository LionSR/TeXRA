// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';

// Third-party imports
import { glob } from 'glob';

// Local imports - utilities
import {
  getBuiltInAgentsDirectory,
  getCustomAgentsDirectory,
} from '../utils/pathUtils';
import { agentConfigToTaskState } from '../utils/configConversion';

// Local imports - agent components
import { AgentConfig, createAgentConfig } from './AgentConfig';
import { AgentSetting, AgentPrompt } from './AgentDataclass';
import { loadAgentSettingAndPrompts } from './agentLoad';
import { MODEL_CONFIGS } from '../model/ModelRegistry';
import { ModelFactory } from './ModelFactory';
import { DirectAgent } from './DirectAgent';
import { CoTAgent } from './CoTAgent';
import { MergeAgent } from './MergeAgent';
import { ProgressViewProvider } from '../progressView/ProgressViewProvider';
import { AgentLogger } from '../logger/AgentLogger';

const CHANNEL = 'executeAgent';
const logger = new AgentLogger(CHANNEL);

type AgentConstructor = {
  new (
    modelHandler: any,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ): DirectAgent | CoTAgent;
};

type AgentWithConfig = {
  config: AgentConfig;
  init(): Promise<void>;
  run(): Promise<void>;
};

/**
 * Find and return the path to agent's yaml configuration file.
 */
export async function getAgentPath(
  agentName: string,
  context: vscode.ExtensionContext,
): Promise<string> {
  try {
    // First check custom agents directory
    const customDir = await getCustomAgentsDirectory();
    if (customDir) {
      const customMatches = await glob(`**/${agentName}.yaml`, {
        cwd: customDir,
        dot: false,
        nodir: true,
        absolute: false,
      });

      if (customMatches.length > 0) {
        return path.join(customDir, path.dirname(customMatches[0]));
      }
    }

    // If not found in custom directory, check built-in directory
    const builtInDir = await getBuiltInAgentsDirectory(context);
    const builtInMatches = await glob(`**/${agentName}.yaml`, {
      cwd: builtInDir,
      dot: false,
      nodir: true,
      absolute: false,
    });

    if (builtInMatches.length === 0) {
      const errorMsg = `Could not find yaml file for agent: ${agentName}`;
      vscode.window.showErrorMessage(
        `${errorMsg} in either custom or built-in directories`,
      );
      throw new Error(errorMsg);
    }

    // Return the directory containing the yaml file
    return path.join(builtInDir, path.dirname(builtInMatches[0]));
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
function getAgentName(
  baseAgent: string,
  outputFiles: string[] | null | undefined,
): string {
  if (outputFiles && outputFiles.length > 1) {
    // logger.info(CHANNEL, `Switching to multiple output mode`);
    return `${baseAgent}_multiple`;
  }
  return baseAgent;
}

/**
 * Common function to execute any agent with proper logging and status handling
 */
async function executeAgentWithLogging<T extends AgentWithConfig>(
  agentName: string,
  createAgentFn: () => Promise<T>,
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // Get logger instance
    const progressViewProvider = ProgressViewProvider.getInstance();
    if (!progressViewProvider) {
      throw new Error('ProgressViewProvider not initialized');
    }

    // Create agent to get config for stream ID
    const agent = await createAgentFn();

    // Get the full stream ID
    const config = agent.config;
    const fullStreamId = `${agentName}@${config.model}: ${path.basename(config.inputFile)}`;

    // Check if this stream is already running
    const currentStatus = progressViewProvider.getStreamStatus(fullStreamId);
    if (currentStatus === 'running') {
      const errorMsg = `Task "${fullStreamId}" is already running. Please wait for it to complete or stop it first.`;
      // vscode.window.showErrorMessage(errorMsg);
      throw new Error(errorMsg);
    }

    // Check if the progress view is visible, if not show a helpful message
    if (!progressViewProvider.isViewVisible()) {
      const inputFileName = path.basename(config.inputFile);
      const outputInfo = config.outputFiles?.length
        ? `to ${
            config.outputFiles.length > 1
              ? config.outputFiles.length + ' files'
              : path.basename(config.outputFiles[0])
          }`
        : '';

      vscode.window
        .showInformationMessage(
          `TeXRA Agent Started: "${agentName}" is processing ${inputFileName} with ${config.model} ${outputInfo}. View in ProgressBoard for progress.`,
          {
            modal: false,
            detail:
              'TeXRA agents run in the background and their progress can be tracked in the ProgressBoard.',
          },
          'Show ProgressBoard',
        )
        .then((selection) => {
          if (selection === 'Show ProgressBoard') {
            vscode.commands.executeCommand('texra.showProgressView');
          }
        });
    }

    // Create a main task group for the entire execution
    const mainTaskGroupId = await logger.startGroup(
      `Task: ${agentName}@${config.model}`,
    );

    try {
      // Create a log group for execution details as a sub-group
      const taskDetailsGroupId = await logger.startGroup(
        `Task Details`,
        undefined,
        mainTaskGroupId,
      );

      logger.info(
        `Starting task execution for ${fullStreamId}`,
        taskDetailsGroupId,
      );
      logger.info(`Input file: ${config.inputFile}`, taskDetailsGroupId);

      try {
        // Initializes user variables
        await agent.init();

        logger.debug(
          `Creating stream with ID: ${fullStreamId}`,
          taskDetailsGroupId,
        );
        logger.debug(
          `Agent name: ${agentName}, Model: ${config.model}, Input file: ${config.inputFile}`,
          taskDetailsGroupId,
        );
        logger.debug(
          `Config has output files: ${!!config.outputFiles}, Number of output files: ${config.outputFiles?.length || 0}`,
          taskDetailsGroupId,
        );

        // Switch to this stream and set its status to running
        progressViewProvider.setActiveStream(fullStreamId);
        progressViewProvider.updateStreamStatus(fullStreamId, 'running');

        // Store taskState
        logger.debug(
          `Storing taskState for stream: ${fullStreamId}`,
          taskDetailsGroupId,
        );
        logger.debug(
          `Config for taskState: ${JSON.stringify(config)}`,
          taskDetailsGroupId,
        );

        // End the task details group
        logger.endGroup(taskDetailsGroupId, 'stopped');

        // Convert AgentConfig to TaskState using utility function
        progressViewProvider.setTaskState(
          fullStreamId,
          agentConfigToTaskState(config),
        );
        logger.debug(
          `Task state stored for stream: ${fullStreamId}`,
          mainTaskGroupId,
        );

        try {
          // Run the agent
          logger.info(
            `Executing ${agentName} with model ${config.model}`,
            mainTaskGroupId,
          );
          await agent.run();
          // Mark the task as completed successfully
          logger.info(`Task completed successfully`, mainTaskGroupId);
          logger.endGroup(mainTaskGroupId, 'stopped');
          // Update status to stopped on successful completion
          progressViewProvider.updateStreamStatus(fullStreamId, 'stopped');
        } catch (err) {
          // Mark the task as failed
          logger.error(
            `Task failed: ${err instanceof Error ? err.message : String(err)}`,
            mainTaskGroupId,
          );
          logger.endGroup(mainTaskGroupId, 'error');
          // Update status to error if agent run fails
          progressViewProvider.updateStreamStatus(fullStreamId, 'error');
          throw err;
        }
      } catch (err) {
        // End the details group if it's still active
        if (taskDetailsGroupId) {
          logger.endGroup(taskDetailsGroupId, 'error');
        }

        // End the main group with error status if any initialization error occurs
        logger.error(
          `Task initialization failed: ${err instanceof Error ? err.message : String(err)}`,
          mainTaskGroupId,
        );
        logger.endGroup(mainTaskGroupId, 'error');
        throw err;
      }
    } catch (err) {
      // Ensure the main group is ended even if there was an error in nested groups
      if (mainTaskGroupId) {
        logger.endGroup(mainTaskGroupId, 'error');
      }
      throw err;
    }
  } catch (err) {
    const errorMsg = `Error executing agent ${agentName}: ${err instanceof Error ? err.message : String(err)}`;

    // Check if the error is related to missing API key
    if (
      errorMsg.includes('Missing API key') ||
      errorMsg.includes('API key not found')
    ) {
      const setKey = 'Set API Key';
      const result = await vscode.window.showErrorMessage(
        errorMsg,
        { modal: true },
        setKey,
      );

      if (result === setKey) {
        vscode.commands.executeCommand('texra.setApiKey');
      }
    } else {
      // Show regular error message for other errors
      vscode.window.showErrorMessage(errorMsg);
    }

    // Create a temporary error group if no active group exists
    const errorGroupId = await logger.startGroup(`Error: ${agentName}`);
    logger.error(errorMsg, errorGroupId);
    logger.endGroup(errorGroupId, 'error');
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

  await executeAgentWithLogging(
    agentName,
    async () => {
      // Create full agent config
      const fullConfig = createAgentConfig(agentConfig);

      // Get model configuration
      const modelName = fullConfig.model;
      if (!(modelName in MODEL_CONFIGS)) {
        throw new Error(`Model ${modelName} not found in MODEL_CONFIGS`);
      }

      const modelConfig = MODEL_CONFIGS[modelName];
      // Only set toolConfig reference - no need to override openRouterOnly
      modelConfig.toolConfig = fullConfig.toolConfig;

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
    },
    context,
  );
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

  await executeAgentWithLogging(
    agentName,
    async () => {
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
    },
    context,
  );
}
