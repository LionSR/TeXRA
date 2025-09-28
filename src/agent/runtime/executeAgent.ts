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
  resolveAgentSessionMetadata,
} from '@agent/core/AgentDataclass';
import { IAgent } from '@agent/core/IAgent';
import {
  DirectAgent,
  CoTAgent,
  MergeAgent,
  BaseToolUseAgent,
} from '@agent/implementations';
import {
  loadAgentSettingAndPrompts,
  ensureAgentTypeForSource,
} from '@agent/runtime/agentLoad';
import { ModelFactory } from '@agent/runtime/ModelFactory';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import { bus } from '@eventBus/ProgressEventBus';
import {
  AgentDirectorySource,
  type AgentPathResolution,
} from './AgentPathTypes';

// Local imports - utilities
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { AgentLogger } from '@logger/AgentLogger';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { agentConfigToTaskState } from '@utils/config';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

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
    executionId?: ExecutionId,
  ): IAgent;
};

/**
 * Find and return the path to agent's yaml configuration file.
 */
export async function getAgentPath(
  agentName: string,
  context: vscode.ExtensionContext,
): Promise<AgentPathResolution> {
  try {
    // First check custom agents directory
    const customDir = await agentDirectories.custom(context);
    if (customDir) {
      const customMatches = await glob(`**/${agentName}.yaml`, {
        cwd: customDir,
        dot: false,
        nodir: true,
        absolute: false,
      });

      if (customMatches.length > 0) {
        return {
          directory: path.join(customDir, path.dirname(customMatches[0])),
          source: AgentDirectorySource.Custom,
        };
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
      const view = await vscode.commands.executeCommand<vscode.WebviewView>(
        'texra.getWebviewView',
      );
      const customDir = await agentDirectories.custom(context);
      view?.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER,
        agentName,
        customDirSet: !!customDir,
      });
      const errorMsg = `Could not find yaml file for agent: ${agentName}`;
      throw new Error(errorMsg);
    }

    // Return the directory containing the yaml file
    if (builtInMatches.length > 0) {
      return {
        directory: path.join(builtInDir, path.dirname(builtInMatches[0])),
        source: AgentDirectorySource.BuiltIn,
      };
    }
    return {
      directory: path.join(builtInToolUseDir, path.dirname(toolUseMatches[0])),
      source: AgentDirectorySource.BuiltInToolUse,
    };
  } catch (err) {
    const errorMsg = `Error finding agent path: ${err instanceof Error ? err.message : String(err)}`;
    // Don't show error notification for missing YAML files - we handle it with banner
    if (!err?.toString().includes('Could not find yaml file for agent')) {
      vscode.window.showErrorMessage(errorMsg);
    }
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
    toolUse: BaseToolUseAgent,
  };
  return agentTypeMapping[settings.agentType] || DirectAgent;
}

/**
 * Get agent name with optional multiple suffix.
 */
function getAgentName(
  baseAgent: string,
  useMultipleOutputs: boolean | undefined,
): string {
  if (useMultipleOutputs) {
    // logger.info(CHANNEL, `Switching to multiple output mode`);
    return baseAgent.endsWith('_multiple')
      ? baseAgent
      : `${baseAgent}_multiple`;
  }
  return baseAgent;
}

/**
 * Common function to execute any agent with proper logging and status handling
 */
interface ExecuteAgentOptions {
  resume?: boolean;
}

export async function executeAgentWithLogging<T extends IAgent>(
  agentName: string,
  createAgentFn: () => Promise<{ agent: T; agentType?: AgentType }>,
  context: vscode.ExtensionContext,
  executionId?: ExecutionId,
  options?: ExecuteAgentOptions,
): Promise<void> {
  const isResume = options?.resume ?? false;
  let streamTabId: StreamTabId | undefined;
  let agentStreamLogger: AgentLogger | undefined;
  try {
    // Create agent instance and extract its declared type
    const { agent, agentType } = await createAgentFn();
    const sessionMetadata = agent.getSessionMetadata();
    const metadata = resolveAgentSessionMetadata(
      agentType ?? sessionMetadata.agentType,
      sessionMetadata.agentSessionKind,
    );

    if (executionId) {
      await ensureRunDir(executionId);
    }

    // Get the full stream tab ID
    const config = agent.config;
    streamTabId = getStreamTabId(config.agent, config.model, config.inputFile, {
      agentType: metadata.agentType,
      executionId,
      useMultipleOutputs: config.useMultipleOutputs,
    });

    if (!streamTabId) {
      throw new Error('Failed to resolve stream tab ID for agent execution');
    }

    agentStreamLogger = new AgentLogger(streamTabId, true);

    // Check if this stream is already running
    const provider = ProgressViewProvider.getInstance();
    const currentStatus = provider?.eventHandler.getStreamStatus(streamTabId);
    if (!isResume && currentStatus === 'running') {
      const errorMsg = `Task "${streamTabId}" is already running. Please wait for it to complete or stop it first.`;
      throw new Error(errorMsg);
    }

    // Create a main task group for the entire execution
    const mainTaskGroupId = isResume
      ? undefined
      : await logger.startGroup(`Task: ${agentName}@${config.model}`);

    try {
      // Create a log group for execution details as a sub-group
      const taskDetailsGroupId = isResume
        ? undefined
        : await logger.startGroup(`Task Details`, undefined, mainTaskGroupId);

      if (!isResume && taskDetailsGroupId) {
        logger.info(
          `Starting task execution for ${streamTabId}`,
          taskDetailsGroupId,
        );
        logger.info(`Input file: ${config.inputFile}`, taskDetailsGroupId);
      }

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
          `Config has output files: ${!!config.outputFiles}, Number of output files: ${config.outputFiles?.length || 0}, useMultipleOutputs: ${config.useMultipleOutputs}`,
          taskDetailsGroupId,
        );

        // Switch to this stream and set its status to running
        bus.emit('setActiveStream', {
          stream: streamTabId,
          agentType: metadata.agentType,
          agentSessionKind: metadata.agentSessionKind,
        });
        bus.emit('updateStreamStatus', {
          stream: streamTabId,
          status: 'running',
        });

        if (!isResume) {
          const viewVisible = provider?.isViewVisible() ?? false;
          if (!viewVisible) {
            await vscode.commands.executeCommand('texra.showProgressView');
          }

          if (!provider?.isViewVisible()) {
            const inputFileName = path.basename(config.inputFile);
            const outputInfo = config.useMultipleOutputs
              ? config.outputFiles?.length
                ? `to ${
                    config.outputFiles.length > 1
                      ? `${config.outputFiles.length} files`
                      : path.basename(config.outputFiles[0])
                  }`
                : 'for multiple outputs'
              : config.outputFiles?.length
                ? `to ${path.basename(config.outputFiles[0])}`
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
          if (taskDetailsGroupId) {
            logger.endGroup(taskDetailsGroupId, 'stopped');
          }

          // Convert AgentConfig to TaskState using utility function
          bus.emit('setTaskState', {
            streamTabId: streamTabId,
            executionId,
            taskState: agentConfigToTaskState(config, metadata),
          });
          logger.debug(
            `Task state stored for stream: ${streamTabId}`,
            mainTaskGroupId,
          );
        }

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
          if (mainTaskGroupId) {
            logger.endGroup(mainTaskGroupId, 'stopped');
          }
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
          if (mainTaskGroupId) {
            logger.endGroup(mainTaskGroupId, 'error');
          }
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
        if (mainTaskGroupId) {
          logger.endGroup(mainTaskGroupId, 'error');
        }
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

    if (agentStreamLogger || streamTabId) {
      if (!agentStreamLogger && streamTabId) {
        agentStreamLogger = new AgentLogger(streamTabId, true);
      }
      if (agentStreamLogger) {
        const activeGroupId = agentStreamLogger.getActiveGroupId();
        if (activeGroupId) {
          agentStreamLogger.error(errorMsg, activeGroupId);
        } else {
          const agentErrorGroupId = await agentStreamLogger.startGroup(
            `Error: ${agentName}`,
          );
          agentStreamLogger.error(errorMsg, agentErrorGroupId);
          agentStreamLogger.endGroup(agentErrorGroupId, 'error');
        }
      }
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

  const requestedAgentName = agentConfig.agent;
  const agentName = getAgentName(
    requestedAgentName,
    agentConfig.useMultipleOutputs,
  );

  await executeAgentWithLogging(
    agentName,
    async () => {
      // Create full agent config
      const fullConfig = AgentConfigSchema.parse(agentConfig);

      if (
        Array.isArray(fullConfig.outputFiles) &&
        fullConfig.outputFiles.length > 1 &&
        !fullConfig.useMultipleOutputs
      ) {
        logger.warn(
          `Multiple output files provided (${fullConfig.outputFiles.length}) but useMultipleOutputs flag is disabled. Update the agent configuration to ensure consistent stream handling.`,
        );
      }

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
      // Only set toolConfig reference - no need to override openRouterOnly
      modelConfig.toolConfig = fullConfig.toolConfig;

      // Create model handler
      const modelHandler = ModelFactory.createHandler(modelConfig);

      // Get agent path
      const agentPathInfo = await getAgentPath(fullConfig.agent, context);

      // Load settings and prompts
      const [loadedAgentSetting, agentPrompt] =
        await loadAgentSettingAndPrompts(agentPathInfo, requestedAgentName, {
          preferMultiple: fullConfig.useMultipleOutputs,
        });
      const agentSetting = ensureAgentTypeForSource(
        loadedAgentSetting,
        agentPathInfo.source,
      );

      // Get appropriate agent class and create instance
      const AgentClass = getAgentClass(agentSetting);
      const agent = new AgentClass(
        modelHandler,
        fullConfig,
        agentSetting,
        agentPrompt,
        agentPathInfo.directory,
        executionId,
      );
      return { agent, agentType: agentSetting.agentType };
    },
    context,
    executionId,
    { resume: false },
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
      const agentConfig = AgentConfigSchema.parse({
        agent: 'merge',
        model,
        inputFile,
        editedFile,
      });

      // Get model configuration
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

      // Get agent path and load settings/prompts
      const agentPathInfo = await getAgentPath('merge', context);
      const [loadedAgentSetting, agentPrompt] =
        await loadAgentSettingAndPrompts(agentPathInfo, 'merge');
      const agentSetting = ensureAgentTypeForSource(
        loadedAgentSetting,
        agentPathInfo.source,
      );

      const agent = new MergeAgent(
        modelHandler,
        agentConfig,
        agentSetting,
        agentPrompt,
        agentPathInfo.directory,
      );
      return { agent, agentType: agentSetting.agentType };
    },
    context,
    undefined,
  );
}
