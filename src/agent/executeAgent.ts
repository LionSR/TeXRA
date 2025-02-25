// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';
import { glob } from 'glob';

// Third-party imports
// (none needed)

// Local imports - utilities
import {
  getBuiltInAgentsDirectory,
  getCustomAgentsDirectory,
} from '../utils/pathUtils';

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
    const logViewProvider = LogViewProvider.getInstance();
    if (!logViewProvider) {
      throw new Error('LogViewProvider not initialized');
    }

    // Create agent to get config for stream ID
    const agent = await createAgentFn();

    // Get the full stream ID
    const config = agent.config;
    const fullStreamId = `${agentName}@${config.model}: ${path.basename(config.inputFile)}`;

    // Check if this stream is already running
    const currentStatus = logViewProvider.getStreamStatus(fullStreamId);
    if (currentStatus === 'running') {
      const errorMsg = `Task "${fullStreamId}" is already running. Please wait for it to complete or stop it first.`;
      // vscode.window.showErrorMessage(errorMsg);
      throw new Error(errorMsg);
    }

    // Initializes user variables
    await agent.init();

    logger.debug(`Creating stream with ID: ${fullStreamId}`);
    logger.debug(
      `Agent name: ${agentName}, Model: ${config.model}, Input file: ${config.inputFile}`,
    );
    logger.debug(
      `Config has output files: ${!!config.outputFiles}, Number of output files: ${config.outputFiles?.length || 0}`,
    );

    // Switch to this stream and set its status to running
    logViewProvider.setActiveStream(fullStreamId);
    logViewProvider.updateStreamStatus(fullStreamId, 'running');

    // Store taskState
    logger.debug(`Storing taskState for stream: ${fullStreamId}`);
    logger.debug(`Config for taskState: ${JSON.stringify(config)}`);

    // TODO:this is really mess, we should either use a unified data structure for TaskState and AgentConfig, or define a function that converts AgentConfig to TaskState for it. We have this mess in @TaskState.ts and @LogViewMessageHandler.ts too.
    logViewProvider.setTaskState(fullStreamId, {
      // Parameters
      agent: config.agent,
      model: config.model,
      instruction: config.instruction || '',
      // Input/Output configuration
      inputFile: config.inputFile || '',
      referenceFile: config.referenceFile || '',
      auxiliaryFile: config.auxiliaryFile || '',
      figureFile: config.figureFile || '',
      outputNameOverride: config.outputNameOverride || '',
      // Multiple file selections
      multipleInputFiles: config.inputFiles || [],
      multipleReferenceFiles: config.referenceFiles || [],
      multipleAuxiliaryFiles: config.auxiliaryFiles || [],
      multipleFigureFiles: config.figureFiles || [],
      multipleOutputFiles: config.outputFiles || [],
      // Multiple file selection visibility
      multipleInputFilesVisible:
        Array.isArray(config.inputFiles) && config.inputFiles.length > 0,
      multipleReferenceFilesVisible:
        Array.isArray(config.referenceFiles) &&
        config.referenceFiles.length > 0,
      multipleAuxiliaryFilesVisible:
        Array.isArray(config.auxiliaryFiles) &&
        config.auxiliaryFiles.length > 0,
      multipleFigureFilesVisible:
        Array.isArray(config.figureFiles) && config.figureFiles.length > 0,
      multipleOutputFilesVisible:
        Array.isArray(config.outputFiles) && config.outputFiles.length > 0,
      // Auto extract settings
      autoExtractFigure: config.toolConfig?.autoExtractFigure || false,
      autoExtractTikzFigure: config.toolConfig?.autoExtractTikzFigure || false,
      autoExtractTikzFigureReflect:
        config.toolConfig?.autoExtractTikzFigureReflect || false,
      // Tool use settings
      reflect: config.toolConfig?.reflect || false,
      attachTeXCount: config.toolConfig?.attachTeXCount || false,
      usePrefillFromInput: config.toolConfig?.usePrefillFromInput || false,
      printInputPrompt: config.toolConfig?.printInputPrompt || false,
      autoConfirmation: config.toolConfig?.autoConfirmation || false,
      outputNameOverrideVisible: !!config.outputNameOverride,
    });
    logger.debug(`Task state stored for stream: ${fullStreamId}`);

    try {
      // Run the agent
      await agent.run();
      // Update status to stopped on successful completion
      logViewProvider.updateStreamStatus(fullStreamId, 'stopped');
    } catch (err) {
      // Update status to error if agent run fails
      logViewProvider.updateStreamStatus(fullStreamId, 'error');
      throw err;
    }
  } catch (err) {
    const errorMsg = `Error executing agent ${agentName}: ${err instanceof Error ? err.message : String(err)}`;
    vscode.window.showErrorMessage(errorMsg);
    logger.error(errorMsg);
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
