// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent components
import { parseAgentConfig, type AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
  getAgentSessionDescriptor,
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
import {
  AgentExecutionContext,
  type AgentExecutionContextInit,
} from './AgentExecutionContext';

// Local imports - utilities
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { AgentLogger } from '@logger/AgentLogger';
import { getStreamTabId } from '@/logger/streamUtils';
import { MODEL_CONFIGS } from '@model/ModelRegistry';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { agentConfigToTaskState } from '@utils/config';
import { ensureRunDir } from '@utils/files/taskRunStorage';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import {
  createCandidate,
  resolveAgentDefinition,
  type AgentDefinitionSearchOptions,
  type AgentDirectoryCandidate,
} from '@agent/utils/agentPathResolver';

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
    context: AgentExecutionContext,
  ): IAgent;
};

/**
 * Find and return the path to agent's yaml configuration file.
 */
export async function getAgentPath(
  agentName: string,
  options?: AgentDefinitionSearchOptions,
): Promise<AgentPathResolution> {
  try {
    const [customDir, builtInDir, builtInToolUseDir] = await Promise.all([
      agentDirectories.custom(),
      agentDirectories.builtIn(),
      agentDirectories.builtInToolUse(),
    ]);

    const candidates = [
      customDir && createCandidate(customDir, AgentDirectorySource.Custom),
      builtInDir && createCandidate(builtInDir, AgentDirectorySource.BuiltIn),
      builtInToolUseDir &&
        createCandidate(builtInToolUseDir, AgentDirectorySource.BuiltInToolUse),
    ].filter(Boolean) as AgentDirectoryCandidate[];

    if (candidates.length === 0) {
      throw new Error('No agent directories available for lookup');
    }

    const resolution = await resolveAgentDefinition(
      agentName,
      candidates,
      options,
    );
    if (resolution) {
      return resolution;
    }

    const customDirSet = candidates.some(
      (candidate) => candidate.source === AgentDirectorySource.Custom,
    );

    const view = await vscode.commands.executeCommand<vscode.WebviewView>(
      'texra.getWebviewView',
    );
    view?.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER,
      agentName,
      customDirSet,
    });
    const errorMsg = `Could not find yaml file for agent: ${agentName}`;
    throw new Error(errorMsg);
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
 * Parameters for creating and configuring an agent instance.
 */
interface PrepareAgentInstanceParams {
  /** Name of the agent to instantiate (without _multiple suffix) */
  agentName: string;
  /** Partial agent configuration to merge with defaults */
  configPayload: Partial<AgentConfig>;
  /** Optional execution ID for tracking and logging */
  executionId?: ExecutionId;
  /** Optional agent class to use instead of automatic selection based on agent type */
  agentClassOverride?: AgentConstructor;
  /** Optional factory for constructing the execution context */
  contextFactory?: (init: AgentExecutionContextInit) => AgentExecutionContext;
}

/**
 * Create and configure an agent instance from the provided configuration.
 *
 * This helper centralizes agent instantiation logic including:
 * - Model validation and configuration
 * - Agent path resolution with _multiple variant fallback
 * - Settings and prompt loading
 * - Agent class selection and construction
 *
 * The function handles the _multiple variant resolution automatically:
 * - When useMultipleOutputs is true, it first tries to load the _multiple variant
 * - If the _multiple variant doesn't exist, it falls back to the base agent
 * - The returned agent config always contains the original agent name
 *
 * @template T - The expected agent type (defaults to IAgent)
 * @param params - Configuration parameters for agent creation
 * @returns Promise resolving to the constructed agent instance and its type
 * @throws Error if model is not found in MODEL_CONFIGS
 * @throws Error if agent YAML file cannot be located (after fallback attempts)
 *
 * @example
 * // Create a standard agent
 * const { agent, agentType } = await prepareAgentInstance({
 *   agentName: 'my-agent',
 *   configPayload: { model: 'gpt-4', inputFile: 'input.tex' },
 *   context,
 * });
 *
 * @example
 * // Create a merge agent with class override
 * const { agent, agentType } = await prepareAgentInstance<MergeAgent>({
 *   agentName: 'merge-agent',
 *   configPayload: { model: 'claude-3-5-sonnet-20241022', inputFile: 'input.tex' },
 *   context,
 *   agentClassOverride: MergeAgent,
 * });
 */
export async function prepareAgentInstance<T extends IAgent = IAgent>(
  params: PrepareAgentInstanceParams,
): Promise<{ agent: T; agentType: AgentType; context: AgentExecutionContext }> {
  const {
    agentName,
    configPayload,
    executionId,
    agentClassOverride,
    contextFactory,
  } = params;

  const configInput: Partial<AgentConfig> = {
    agent: agentName,
    ...configPayload,
  };

  const fullConfig = parseAgentConfig(configInput);
  const originalAgentName = fullConfig.agent;
  const resolution = await getAgentPath(originalAgentName, {
    preferMultiple: fullConfig.useMultipleOutputs,
  });
  const resolvedAgentName = resolution.resolvedName;

  const [loadedAgentSetting, agentPrompt] = await loadAgentSettingAndPrompts(
    resolution,
    { preferMultiple: fullConfig.useMultipleOutputs },
  );

  const agentSetting = ensureAgentTypeForSource(
    loadedAgentSetting,
    resolution.source,
  );

  const sessionDescriptor = getAgentSessionDescriptor(agentSetting);

  const agentConfig: AgentConfig = {
    ...fullConfig,
    agent: originalAgentName,
    agentType: sessionDescriptor.agentType,
    session: sessionDescriptor,
  };

  const modelName = agentConfig.model;

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

  const baseModelConfig = MODEL_CONFIGS[modelName];
  const modelConfig = {
    ...baseModelConfig,
    toolConfig: agentConfig.toolConfig,
  };

  const modelHandler = ModelFactory.createHandler(modelConfig);

  const AgentClass = (agentClassOverride ??
    getAgentClass(agentSetting)) as AgentConstructor;

  const streamId = getStreamTabId(
    agentConfig.agent,
    modelName,
    agentConfig.inputFile,
    {
      agentType: agentSetting.agentType,
      executionId,
      useMultipleOutputs: agentConfig.useMultipleOutputs,
    },
  );

  const context = contextFactory
    ? contextFactory({ streamId, executionId })
    : new AgentExecutionContext({ streamId, executionId });

  const agent = new AgentClass(
    modelHandler,
    agentConfig,
    agentSetting,
    agentPrompt,
    resolution.directory,
    context,
  );

  return {
    agent: agent as T,
    agentType: agentSetting.agentType,
    context,
  };
}

/**
 * Common function to execute any agent with proper logging and status handling
 */
interface ExecuteAgentOptions {
  resume?: boolean;
}

export async function executeAgentWithLogging<T extends IAgent>(
  agentName: string,
  createAgentFn: (
    contextFactory: (init: AgentExecutionContextInit) => AgentExecutionContext,
  ) => Promise<{
    agent: T;
    agentType?: AgentType;
    context?: AgentExecutionContext;
  }>,
  executionId?: ExecutionId,
  options?: ExecuteAgentOptions,
): Promise<void> {
  const isResume = options?.resume ?? false;
  let streamTabId: StreamTabId | undefined;
  let agent: T | undefined;
  let executionContext: AgentExecutionContext | undefined;
  let contextLogger: AgentLogger | undefined;
  try {
    const contextFactory = (init: AgentExecutionContextInit) => {
      if (executionContext?.streamId === init.streamId) {
        return executionContext;
      }
      executionContext = new AgentExecutionContext(init);
      return executionContext;
    };

    // Create agent instance and extract its declared type
    const created = await createAgentFn(contextFactory);
    agent = created.agent;
    const { agentType } = created;
    executionContext =
      created.context ?? executionContext ?? agent.getExecutionContext();

    contextLogger = executionContext.logger;
    const sessionMetadata = agent.getSessionMetadata();

    if (executionId) {
      await ensureRunDir(executionId);
    }

    // Get the full stream tab ID
    const config = agent.config;
    const metadata = config.session;
    if (!metadata) {
      throw new Error('Agent configuration is missing session metadata.');
    }

    streamTabId = agent.getStreamTabId();

    if (!streamTabId) {
      throw new Error('Failed to resolve stream tab ID for agent execution');
    }

    const activeStreamId: StreamTabId = streamTabId;

    // Check if this stream is already running
    const provider = ProgressViewProvider.getInstance();
    const currentStatus =
      provider?.eventHandler.getStreamStatus(activeStreamId);
    if (!isResume && currentStatus === 'running') {
      const errorMsg = `Task "${activeStreamId}" is already running. Please wait for it to complete or stop it first.`;
      throw new Error(errorMsg);
    }

    await logger.withScope(
      `Task: ${agentName}@${config.model}`,
      async () => {
        try {
          await logger.withScope(
            `Task Details`,
            async () => {
              if (!isResume) {
                logger.info(`Starting task execution for ${activeStreamId}`);
                logger.info(`Input file: ${config.inputFile}`);
              }

              logger.debug(`Creating stream with ID: ${activeStreamId}`);
              logger.debug(
                `Agent name: ${agentName}, Model: ${config.model}, Input file: ${config.inputFile}`,
              );
              logger.debug(
                `Config has output files: ${!!config.outputFiles}, Number of output files: ${config.outputFiles?.length || 0}, useMultipleOutputs: ${config.useMultipleOutputs}`,
              );

              // Switch to this stream and set its status to running
              bus.emit('setActiveStream', {
                stream: activeStreamId,
                session: metadata,
              });
              bus.emit('updateStreamStatus', {
                stream: activeStreamId,
                status: 'running',
              });

              if (!isResume) {
                const viewVisible = provider?.isViewVisible() ?? false;
                if (!viewVisible) {
                  await vscode.commands.executeCommand(
                    'texra.showProgressView',
                  );
                }

                if (!provider?.isViewVisible()) {
                  const inputFileName = config.inputFile
                    ? path.basename(config.inputFile)
                    : 'selected input';
                  const outputInfo = (() => {
                    if (config.useMultipleOutputs) {
                      const outputs = config.outputFiles ?? [];
                      if (outputs.length > 1) {
                        return `to ${outputs.length} files`;
                      }
                      const [firstOutput] = outputs;
                      return firstOutput
                        ? `to ${path.basename(firstOutput)}`
                        : 'for multiple outputs';
                    }

                    const [singleOutput] = config.outputFiles ?? [];
                    return singleOutput
                      ? `to ${path.basename(singleOutput)}`
                      : '';
                  })();

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
                        vscode.commands.executeCommand(
                          'texra.showProgressView',
                        );
                      }
                    });
                }

                logger.debug(`Storing taskState for stream: ${activeStreamId}`);
                logger.debug(`Config for taskState: ${JSON.stringify(config)}`);

                bus.emit('setTaskState', {
                  streamTabId: activeStreamId,
                  executionId,
                  taskState: agentConfigToTaskState(config),
                });
                logger.debug(`Task state stored for stream: ${activeStreamId}`);
              }
            },
            { skip: isResume },
          );
        } catch (err) {
          logger.error(
            `Task initialization failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }

        try {
          logger.info(`Executing ${agentName} with model ${config.model}`);
          if (!agent) {
            throw new Error('Agent instance was not initialized');
          }

          await agent.run();
          logger.debug(`Task completed successfully`);
          bus.emit('updateStreamStatus', {
            stream: activeStreamId,
            status: 'stopped',
          });
        } catch (err) {
          logger.error(
            `Task failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          bus.emit('updateStreamStatus', {
            stream: activeStreamId,
            status: 'error',
          });
          throw err;
        }
      },
      { skip: isResume },
    );
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

    const agentLoggerFallback =
      executionContext?.logger ??
      contextLogger ??
      (streamTabId ? new AgentLogger(streamTabId, true) : undefined);
    if (agentLoggerFallback) {
      const fallbackGroupId =
        agentLoggerFallback.getActiveGroupId() ?? agent?.getLastRunGroupId();
      if (fallbackGroupId) {
        await agentLoggerFallback.withActiveGroup(fallbackGroupId, async () => {
          agentLoggerFallback.error(errorMsg);
        });
      } else {
        await agentLoggerFallback.withScope(
          `Error: ${agentName}`,
          async () => {
            agentLoggerFallback.error(errorMsg);
          },
          { errorStatus: 'error' },
        );
      }
    }

    await logger.withScope(
      `Error: ${agentName}`,
      async () => {
        logger.error(errorMsg);
      },
      { errorStatus: 'error' },
    );
    throw new Error(errorMsg);
  }
}

export async function executeAgent(
  agentConfig: Partial<AgentConfig>,
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
    async (contextFactory) => {
      const { agent, agentType, context } = await prepareAgentInstance({
        agentName: requestedAgentName,
        configPayload: agentConfig,
        executionId,
        contextFactory,
      });

      const { outputFiles, useMultipleOutputs } = agent.config;
      if (
        Array.isArray(outputFiles) &&
        outputFiles.length > 1 &&
        !useMultipleOutputs
      ) {
        logger.warn(
          `Multiple output files provided (${outputFiles.length}) but useMultipleOutputs flag is disabled. Update the agent configuration to ensure consistent stream handling.`,
        );
      }

      return { agent, agentType, context };
    },
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
): Promise<void> {
  const agentName = 'merge';

  await executeAgentWithLogging(
    agentName,
    async (contextFactory) => {
      const { agent, agentType, context } =
        await prepareAgentInstance<MergeAgent>({
          agentName,
          configPayload: { agent: agentName, model, inputFile, editedFile },
          agentClassOverride: MergeAgent,
          contextFactory,
        });

      return { agent, agentType, context };
    },
    undefined,
  );
}
