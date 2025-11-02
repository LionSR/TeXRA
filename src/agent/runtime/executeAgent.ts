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

// Local imports - utilities
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { createChannelLogger, type ChannelLogger } from '@logger/logUtils';
import { withLogGroup } from '@logger/logGroupUtils';
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
const logger = createChannelLogger(CHANNEL);

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
): Promise<{ agent: T; agentType: AgentType }> {
  const { agentName, configPayload, executionId, agentClassOverride } = params;

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

  const agent = new AgentClass(
    modelHandler,
    agentConfig,
    agentSetting,
    agentPrompt,
    resolution.directory,
    executionId,
  );

  return { agent: agent as T, agentType: agentSetting.agentType };
}

/**
 * Common function to execute any agent with proper logging and status handling
 */
interface ExecuteAgentOptions {
  resume?: boolean;
}

interface AgentExecutionSetup<T extends IAgent> {
  agent: T;
  config: AgentConfig;
  streamTabId: StreamTabId;
  metadata: NonNullable<AgentConfig['session']>;
  agentLogger: ChannelLogger;
  provider?: ProgressViewProvider;
}

async function prepareExecutionContext<T extends IAgent>(
  createAgentFn: () => Promise<{ agent: T; agentType?: AgentType }>,
  executionId: ExecutionId | undefined,
  isResume: boolean,
): Promise<AgentExecutionSetup<T>> {
  const created = await createAgentFn();
  const agent = created.agent;

  if (executionId) {
    await ensureRunDir(executionId);
  }

  const config = agent.config;
  const metadata = config.session;
  if (!metadata) {
    throw new Error('Agent configuration is missing session metadata.');
  }

  const streamTabId = agent.getStreamTabId();
  if (!streamTabId) {
    throw new Error('Failed to resolve stream tab ID for agent execution');
  }

  const provider = ProgressViewProvider.getInstance();
  const currentStatus = provider?.eventHandler.getStreamStatus(streamTabId);
  if (!isResume && currentStatus === 'running') {
    throw new Error(
      `Task "${streamTabId}" is already running. Please wait for it to complete or stop it first.`,
    );
  }

  const agentLogger = createChannelLogger(streamTabId, { isAgent: true });

  return { agent, config, streamTabId, metadata, agentLogger, provider };
}

async function initializeExecution<T extends IAgent>(
  setup: AgentExecutionSetup<T>,
  agentName: string,
  executionId: ExecutionId | undefined,
  isResume: boolean,
  mainGroupId?: string,
): Promise<void> {
  const { config, streamTabId, metadata, provider } = setup;

  await withLogGroup(
    logger,
    `Task Details`,
    async (taskDetailsGroupId) => {
      if (!isResume && taskDetailsGroupId) {
        logger.info(
          `Starting task execution for ${streamTabId}`,
          taskDetailsGroupId,
        );
        logger.info(`Input file: ${config.inputFile}`, taskDetailsGroupId);
      }

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

      bus.emit('setActiveStream', {
        stream: streamTabId,
        session: metadata,
      });
      bus.emit('updateStreamStatus', {
        stream: streamTabId,
        status: 'running',
      });

      if (!isResume) {
        const viewVisible = provider?.isViewVisible() ?? false;
        if (!viewVisible) {
          const inputFileName = config.inputFile
            ? path.basename(config.inputFile)
            : 'selected files';
          const outputInfo = (() => {
            if (config.useMultipleOutputs) {
              const outputs = config.outputFiles ?? [];
              const [firstOutput] = outputs;
              return firstOutput
                ? `to ${path.basename(firstOutput)}`
                : 'for multiple outputs';
            }

            const [singleOutput] = config.outputFiles ?? [];
            return singleOutput ? `to ${path.basename(singleOutput)}` : '';
          })();

          void vscode.window
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
      }

      logger.debug(
        `Storing taskState for stream: ${streamTabId}`,
        taskDetailsGroupId,
      );
      logger.debug(
        `Config for taskState: ${JSON.stringify(config)}`,
        taskDetailsGroupId,
      );

      bus.emit('setTaskState', {
        streamTabId,
        executionId,
        taskState: agentConfigToTaskState(config),
      });
      logger.debug(`Task state stored for stream: ${streamTabId}`, mainGroupId);
    },
    { parentGroupId: mainGroupId, skip: isResume },
  );
}

async function runAgentTask<T extends IAgent>(
  setup: AgentExecutionSetup<T>,
  agentName: string,
  mainGroupId?: string,
): Promise<void> {
  const { agent, config, streamTabId } = setup;

  logger.info(`Executing ${agentName} with model ${config.model}`, mainGroupId);

  await agent.run();

  logger.debug(`Task completed successfully`, mainGroupId);
  bus.emit('updateStreamStatus', {
    stream: streamTabId,
    status: 'stopped',
  });
}

async function handleAgentFailure<T extends IAgent>(
  agentName: string,
  error: unknown,
  setup: AgentExecutionSetup<T> | undefined,
): Promise<string> {
  const errorMsg = `Error executing agent ${agentName}: ${error instanceof Error ? error.message : String(error)}`;

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
    vscode.window.showErrorMessage(errorMsg);
  }

  if (setup) {
    const { agentLogger, agent, streamTabId } = setup;
    bus.emit('updateStreamStatus', {
      stream: streamTabId,
      status: 'error',
    });
    const fallbackGroupId =
      agentLogger.getActiveGroupId() ?? agent.getLastRunGroupId();
    if (fallbackGroupId) {
      agentLogger.error(errorMsg, fallbackGroupId);
    } else {
      const agentErrorGroupId = await agentLogger.startGroup(
        `Error: ${agentName}`,
      );
      agentLogger.error(errorMsg, agentErrorGroupId);
      agentLogger.endGroup(agentErrorGroupId, 'error');
    }
  }

  const errorGroupId = await logger.startGroup(`Error: ${agentName}`);
  logger.error(errorMsg, errorGroupId);
  logger.endGroup(errorGroupId, 'error');

  return errorMsg;
}

export async function executeAgentWithLogging<T extends IAgent>(
  agentName: string,
  createAgentFn: () => Promise<{ agent: T; agentType?: AgentType }>,
  executionId?: ExecutionId,
  options?: ExecuteAgentOptions,
): Promise<void> {
  const isResume = options?.resume ?? false;
  let setup: AgentExecutionSetup<T> | undefined;
  try {
    setup = await prepareExecutionContext(createAgentFn, executionId, isResume);
    await withLogGroup(
      logger,
      `Task: ${agentName}@${setup.config.model}`,
      async (mainTaskGroupId) => {
        await initializeExecution(
          setup!,
          agentName,
          executionId,
          isResume,
          mainTaskGroupId,
        );
        await runAgentTask(setup!, agentName, mainTaskGroupId);
      },
      { skip: isResume },
    );
  } catch (err) {
    const formatted = await handleAgentFailure(agentName, err, setup);
    throw new Error(formatted);
  }
}

export async function executeAgent(
  agentConfig: Partial<AgentConfig>,
  executionId?: ExecutionId,
): Promise<void> {
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
      const { agent, agentType } = await prepareAgentInstance({
        agentName: requestedAgentName,
        configPayload: agentConfig,
        executionId,
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

      return { agent, agentType };
    },
    executionId,
    { resume: false },
  );
}
export async function executeMergeAgent(
  model: string,
  inputFile: string,
  editedFile: string,
): Promise<void> {
  const agentName = 'merge';

  await executeAgentWithLogging(
    agentName,
    async () => {
      const { agent, agentType } = await prepareAgentInstance<MergeAgent>({
        agentName,
        configPayload: { agent: agentName, model, inputFile, editedFile },
        agentClassOverride: MergeAgent,
      });

      return { agent, agentType };
    },
    undefined,
  );
}
