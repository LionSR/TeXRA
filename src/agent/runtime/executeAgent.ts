// Standard library imports
import * as path from 'path';

// Third-party imports
import { glob } from 'glob';
import * as vscode from 'vscode';

// Local imports - agent
import { getStreamTabId } from '@/logger/streamUtils';

// Local imports - agent components
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
} from '@agent/core/AgentDataclass';
import { IAgent } from '@agent/core/IAgent';
import {
  DirectAgent,
  CoTAgent,
  MergeAgent,
  BaseToolUseAgent,
} from '@agent/implementations';
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { ModelFactory } from '@agent/runtime/ModelFactory';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - utilities
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { AgentLogger } from '@logger/AgentLogger';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { agentConfigToTaskState } from '@utils/config';
import { ensureRunDir } from '@utils/files/taskRunStorage';

const CHANNEL = 'executeAgent';
const logger = new AgentLogger(CHANNEL);

/**
 * Constructor signature for any agent implementation.
 */
type AgentConstructor = {
  new (
    modelHandler: any,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ): IAgent;
};

/**
 * Find and return the path to agent's yaml configuration file.
 */
export async function getAgentPath(
  agentName: string,
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  try {
    // First check custom agents directory
    const customDir = await agentDirectories.custom();
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
    const builtInDir = await agentDirectories.builtIn(context);
    const builtInMatches = await glob(`**/${agentName}.yaml`, {
      cwd: builtInDir,
      dot: false,
      nodir: true,
      absolute: false,
    });

    // Also check the built-in tool-use directory for agents
    const builtInToolUseDir = await agentDirectories.builtInToolUse(context);
    const toolUseMatches = await glob(`**/${agentName}.yaml`, {
      cwd: builtInToolUseDir,
      dot: false,
      nodir: true,
      absolute: false,
    });

    const allMatches = [...builtInMatches, ...toolUseMatches];

    if (allMatches.length === 0) {
      logger.warn(`Could not find yaml file for agent: ${agentName}`);
      const configureButton = 'Open Settings';
      vscode.window
        .showWarningMessage(
          'Agent configuration is missing. Configure your custom agents directory and ensure the YAML file exists.',
          configureButton,
        )
        .then((selection) => {
          if (selection === configureButton) {
            vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:texra-ai.texra explorer.agentsDirectory',
            );
          }
        });
      return undefined;
    }

    // Return the directory containing the yaml file
    if (builtInMatches.length > 0) {
      return path.join(builtInDir, path.dirname(builtInMatches[0]));
    }
    return path.join(builtInToolUseDir, path.dirname(toolUseMatches[0]));
  } catch (err) {
    const errorMsg = `Error finding agent path: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(errorMsg);
    vscode.window.showWarningMessage(errorMsg);
    return undefined;
  }
}

/**
 * Get agent class based on settings.
 */
function getAgentClass(settings: AgentSetting): AgentConstructor {
  const agentTypeMapping: Record<string, AgentConstructor> = {
    direct: DirectAgent,
    CoT: CoTAgent,
    toolUse: BaseToolUseAgent,
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
async function executeAgentWithLogging<T extends IAgent>(
  agentName: string,
  createAgentFn: () => Promise<{ agent: T; agentType?: AgentType }>,
  context: vscode.ExtensionContext,
  executionId?: ExecutionId,
): Promise<void> {
  try {
    // Create agent instance and extract its declared type
    const { agent, agentType } = await createAgentFn();

    if (executionId && 'setExecutionId' in agent) {
      (agent as any).setExecutionId(executionId);
      await ensureRunDir(executionId);
    }

    // Get the full stream tab ID
    const config = agent.config;
    const streamTabId = getStreamTabId(
      agentName,
      config.model,
      config.inputFile,
    );

    // Check if this stream is already running
    const provider = ProgressViewProvider.getInstance();
    const currentStatus = provider?.eventHandler.getStreamStatus(streamTabId);
    if (currentStatus === 'running') {
      const errorMsg = `Task "${streamTabId}" is already running. Please wait for it to complete or stop it first.`;
      throw new Error(errorMsg);
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
        `Starting task execution for ${streamTabId}`,
        taskDetailsGroupId,
      );
      logger.info(`Input file: ${config.inputFile}`, taskDetailsGroupId);

      try {
        logger.debug(
          `Creating stream with ID: ${streamTabId}`,
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
        bus.emit('setActiveStream', streamTabId);
        bus.emit('updateStreamStatus', {
          stream: streamTabId,
          status: 'running',
        });

        const viewVisible = provider?.isViewVisible() ?? false;
        if (!viewVisible) {
          await vscode.commands.executeCommand('texra.showProgressView');
        }

        if (!provider?.isViewVisible()) {
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

        // Store taskState
        logger.debug(
          `Storing taskState for stream: ${streamTabId}`,
          taskDetailsGroupId,
        );
        logger.debug(
          `Config for taskState: ${JSON.stringify(config)}`,
          taskDetailsGroupId,
        );

        // End the task details group
        logger.endGroup(taskDetailsGroupId, 'stopped');

        // Convert AgentConfig to TaskState using utility function
        bus.emit('setTaskState', {
          streamTabId: streamTabId,
          executionId,
          taskState: agentConfigToTaskState(config, agentType),
        });
        logger.debug(
          `Task state stored for stream: ${streamTabId}`,
          mainTaskGroupId,
        );

        try {
          // Run the agent
          logger.info(
            `Executing ${agentName} with model ${config.model}`,
            mainTaskGroupId,
          );
          await agent.run();
          // await checkExpectedOutputs(config.outputFiles, agent);
          // Mark the task as completed successfully
          logger.debug(`Task completed successfully`, mainTaskGroupId);
          logger.endGroup(mainTaskGroupId, 'stopped');
          // Update status to stopped on successful completion
          bus.emit('updateStreamStatus', {
            stream: streamTabId,
            status: 'stopped',
          });

          const generated: string[] = Object.values(
            (agent as any).outputHandler?.outputFiles || {},
          )
            .flat()
            .filter(Boolean) as string[];
          for (const out of generated) {
            await openBuildDisplayIfTex(out, { preserveFocus: true });
          }
        } catch (err) {
          // Mark the task as failed
          logger.error(
            `Task failed: ${err instanceof Error ? err.message : String(err)}`,
            mainTaskGroupId,
          );
          logger.endGroup(mainTaskGroupId, 'error');
          // Update status to error if agent run fails
          bus.emit('updateStreamStatus', {
            stream: streamTabId,
            status: 'error',
          });
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
      const openGuide = 'Open Settings Guide';
      await showInstructionWithSuppress(
        'missingApiKey',
        'API key not found. Set your API key in the extension settings and run again.',
        [
          {
            title: setKey,
            callback: () => vscode.commands.executeCommand('texra.setApiKey'),
          },
          {
            title: openGuide,
            callback: () =>
              vscode.commands.executeCommand('texra.openDoc', 'configuration'),
          },
        ],
        false,
      );
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
  executionId?: ExecutionId,
): Promise<void> {
  // Ensure required fields
  if (!agentConfig.model || !agentConfig.agent) {
    throw new Error('Missing required fields: model and/or agent');
  }

  const agentName = getAgentName(agentConfig.agent, agentConfig.outputFiles);

  // Create full agent config
  const fullConfig = AgentConfigSchema.parse(agentConfig);

  // Get model configuration
  const modelName = fullConfig.model;
  if (!(modelName in MODEL_CONFIGS)) {
    const openDocs = 'Model Documentation';
    await showInstructionWithSuppress(
      'modelNotRecognized',
      `Model "${modelName}" is not recognized. Review the documentation for supported models.`,
      [
        {
          title: openDocs,
          callback: () =>
            vscode.commands.executeCommand('texra.openDoc', 'models'),
        },
      ],
      false,
    );
    throw new Error(`Model ${modelName} not found in MODEL_CONFIGS`);
  }

  const modelConfig = MODEL_CONFIGS[modelName];
  modelConfig.toolConfig = fullConfig.toolConfig;

  const agentPath = await getAgentPath(fullConfig.agent, context);
  if (!agentPath) {
    vscode.window.showWarningMessage(
      `Agent "${fullConfig.agent}" is unavailable. Configure the agent and try again.`,
    );
    return;
  }

  await executeAgentWithLogging(
    agentName,
    async () => {
      const modelHandler = ModelFactory.createHandler(modelConfig);

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
      return { agent, agentType: agentSetting.agentType };
    },
    context,
    executionId,
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
  const agentPath = await getAgentPath('merge', context);
  if (!agentPath) {
    vscode.window.showWarningMessage(
      'Merge agent configuration is missing. Configure the agent and try again.',
    );
    return;
  }

  await executeAgentWithLogging(
    agentName,
    async () => {
      const agentConfig = AgentConfigSchema.parse({
        agent: 'merge',
        model,
        inputFile,
        editedFile,
      });

      if (!(model in MODEL_CONFIGS)) {
        const openDocs = 'Model Documentation';
        const choice = await vscode.window.showErrorMessage(
          `Model ${model} is not recognized.`,
          openDocs,
        );
        if (choice === openDocs) {
          vscode.commands.executeCommand('texra.openDoc', 'models');
        }
        throw new Error(`Model ${model} not found in MODEL_CONFIGS`);
      }

      const modelConfig = MODEL_CONFIGS[model];
      const modelHandler = ModelFactory.createHandler(modelConfig);
      const [agentSetting, agentPrompt] = await loadAgentSettingAndPrompts(
        agentPath,
        'merge',
      );

      const agent = new MergeAgent(
        modelHandler,
        agentConfig,
        agentSetting,
        agentPrompt,
        agentPath,
      );
      return { agent, agentType: agentSetting.agentType };
    },
    context,
    undefined,
  );
}
