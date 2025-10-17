// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentWorkflowSetting,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { runResponseCycle } from '@agent/core/ResponseCycle';
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
import { ToolState } from '@agent/core/ToolState';
import { BaseAgent } from '@agent/implementations/BaseAgent';
import type { IModelHandler } from '@agent/modelHandlers';
import { OutputHandler, NamedOutputFile, IOutputHandler } from '@agent/output';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { PromptBuilder } from '@agent/utils/PromptBuilder';
import { writePromptToXml } from '@agent/utils/promptUtils';
import { calculateTotalRounds } from '@agent/utils/roundUtils';
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - latex utilities
import { LatexMediaManager } from '@latex';

// Local imports - logging
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - model definitions
import type { ToolDefinition } from '@model';

// Local imports - configuration
import { getConfig } from '@utils/config';

// Local imports - filesystem utilities
import { WorkspaceFS } from '@utils/files';

/**
 * Options for handling round output.
 *
 * @property outputFile - The path to the file where the round's output will be saved.
 * @property endTurn - A flag indicating whether the current turn should be ended after processing.
 * @property processGroupId - (Optional) An identifier for grouping related processes, useful for tracking or managing outputs.
 */
export interface RoundOutputOptions {
  outputFile: string;
  endTurn: boolean;
  processGroupId?: string;
}

/**
 * Abstract base class for agents that support multi-turn reflection and refinement.
 * Provides core functionality for processing inputs, managing state, and handling outputs
 * across multiple conversation rounds.
 */
export abstract class BaseReflectionAgent<C = unknown> extends BaseAgent<C> {
  /** File paths for each round's raw model output. */
  protected outputFile: string[];
  protected outputFiles: { [key: number]: string[] };
  protected baseFiles: string[];
  protected override agentSetting: AgentWorkflowSetting;
  protected useScratchpad: boolean = false;
  protected logId: number = 0;
  /** Handler for output file processing and validation. */
  protected outputHandler: IOutputHandler;
  protected latexMediaManager: LatexMediaManager;
  protected promptBuilder?: PromptBuilder;
  public roundStates: AgentStateRound[] = [];
  public toolStates: ToolState[] = [];

  constructor(
    modelHandler: IModelHandler<any, any, any, any, C>,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    executionId?: ExecutionId,
  ) {
    const workflowSetting = requireWorkflowSetting(agentSetting);
    super(
      modelHandler,
      agentConfig,
      workflowSetting,
      agentPrompt,
      agentPath,
      executionId,
    );
    this.agentSetting = workflowSetting;

    // Initialize basic attributes
    const numRounds = this.getNumberOfRounds();
    this.outputFile = new Array(numRounds);
    this.outputFiles = {};
    for (let i = 0; i < numRounds; i++) {
      this.outputFiles[i] = [];
    }
    this.baseFiles = this.agentConfig.outputFiles || [
      this.agentConfig.inputFile,
    ];

    // Check scratchpad usage
    // this is not so neat
    this.useScratchpad =
      this.agentSetting.prefills?.includes('<scratchpad>') || false;

    // Set output files for all rounds
    for (let i = 0; i < numRounds; i++) {
      this.outputFile[i] = this.getOutputFile(i);
    }

    // Initialize logging
    this.logId = 0;

    this.outputHandler = new OutputHandler(
      this.agentSetting,
      this.agentConfig,
      this.logId,
      this.baseFiles,
      this.logger,
    );

    this.latexMediaManager = new LatexMediaManager(this.logger);
  }

  protected getPromptBuilder(): PromptBuilder {
    if (!this.promptBuilder) {
      this.promptBuilder = new PromptBuilder(
        this.agentPrompt,
        this.agentSetting,
        this.userVars,
        this.logger,
      );
    }

    return this.promptBuilder;
  }

  /**
   * Generates output file path for specified conversation round.
   */
  protected abstract getOutputFile(currRound: number): string;

  /**
   * Returns the configured number of conversation rounds.
   */
  protected getNumberOfRounds(): number {
    return calculateTotalRounds(
      this.agentSetting.rounds,
      this.agentPrompt.userRequest,
    );
  }

  /**
   * Processes completion of conversation round.
   */
  private async handleRoundCompletion(
    currRound: number,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    options: RoundOutputOptions,
  ): Promise<void> {
    const { outputFile, endTurn, processGroupId } = options;
    try {
      // Instead of creating a new group, use the round group directly
      // this.logger.debug(
      //   `State global: ${JSON.stringify(stateGlobal)}`,
      //   processGroupId,
      // );

      await this.handleOutput(currRound, stateRound, stateGlobal, options);

      this.logger.debug(`Completed round ${currRound}`, processGroupId);
    } catch (error) {
      throw error;
    }

    await this.outputHandler.finalizeRound(outputFile, currRound, {
      endTurn,
      groupId: processGroupId,
    });
  }

  /**
   * Processes output files for current round.
   * This method orchestrates the overall output processing flow with clear separation of concerns:
   * 1. Usage tracking via trackRoundUsage
   * 2. LaTeX diff operations via handleLatexdiffofOutput (only when endTurn is true)
   *
   * The actual file processing is handled separately in processOutputFiles.
   *
   * @returns Array of processed output file paths
   */
  protected async handleOutput(
    currRound: number,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    options: RoundOutputOptions,
  ): Promise<string[]> {
    const { outputFile, endTurn, processGroupId } = options;
    // Record usage statistics at the end of each round
    await this.trackRoundUsage(stateGlobal, processGroupId);

    // If this is the end of a turn, handle latexdiff operations as a separate step
    if (endTurn && this.outputHandler.hasRoundOutputs(currRound)) {
      const existingBase = await Promise.all(
        this.baseFiles.map(async (f) => await WorkspaceFS.exists(f)),
      );

      if (existingBase.some((e) => e)) {
        // Pass the process group ID to maintain proper nesting in the log hierarchy
        await this.outputHandler.handleLatexdiffofOutput(
          currRound,
          processGroupId,
        );
      } else {
        this.logger.debug(
          `Skipping latexdiff for round ${currRound} - base files missing`,
          processGroupId,
        );
      }
    }

    return this.outputHandler.ensureRound(currRound);
  }

  /**
   * Executes the shared round lifecycle pipeline used by both processing and reflection flows.
   * Handles output initialization, response generation, and round finalization to keep
   * lifecycle responsibilities centralized.
   *
   * @param currRound - Zero-based index of the round being executed.
   * @param stateRound - Mutable state scoped to the current round of execution.
   * @param stateGlobal - Shared agent state that spans all rounds.
   * @param toolState - Current tool invocation state passed between rounds.
   * @param preparedMessages - Messages prepared for the model before execution.
   * @param prefill - Initial text inserted into the model response buffer.
   * @param outputPath - Filesystem path where model output for this round is stored.
   * @param roundGroupId - Identifier for grouping related log and output operations.
   * @returns Updated round/global state, messages, completion flag, and tool state after execution.
   */
  private async runRoundPipeline(
    currRound: number,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    toolState: ToolState,
    preparedMessages: any[],
    prefill: string,
    outputPath: string,
    roundGroupId: string,
  ): Promise<[AgentStateRound, AgentStateGlobal, any[], boolean, ToolState]> {
    const [endTurn, updatedMessages] =
      await this.modelHandler.initializeOutputAndPrefill(
        this.agentConfig,
        this.agentSetting,
        preparedMessages,
        toolState,
        outputPath,
        prefill,
        roundGroupId,
      );

    if (!endTurn) {
      const client = this.getClientInstance();
      const options: ResponseCycleOptions<C> = {
        modelHandler: this.modelHandler,
        agentSetting: this.agentSetting,
        agentConfig: this.agentConfig,
        agentPrompt: this.agentPrompt,
        userVars: this.userVars,
        logger: this.logger,
        client,
        checkInterruption: () => this.checkInterruption(),
        setAbortController: (ctrl) => {
          this.abortController = ctrl;
        },
      };

      const [
        updatedStateRound,
        updatedStateGlobal,
        updatedToolState,
        newEndTurn,
      ] = await runResponseCycle(
        options,
        updatedMessages,
        stateRound,
        stateGlobal,
        toolState,
        outputPath,
        roundGroupId,
        this.executionId,
      );

      // The round state is forwarded to handleRoundCompletion so subclasses can
      // maintain a consistent signature even when this helper doesn't mutate it directly.
      await this.handleRoundCompletion(
        currRound,
        updatedStateRound,
        updatedStateGlobal,
        {
          outputFile: outputPath,
          endTurn: newEndTurn,
          processGroupId: roundGroupId,
        },
      );

      if (currRound === 0) {
        this.logger.debug(
          `stateGlobal: ${JSON.stringify(updatedStateGlobal)}`,
          roundGroupId,
        );
      }

      return [
        updatedStateRound,
        updatedStateGlobal,
        updatedMessages,
        newEndTurn,
        updatedToolState,
      ];
    }

    await this.handleRoundCompletion(currRound, stateRound, stateGlobal, {
      outputFile: outputPath,
      endTurn,
      processGroupId: roundGroupId,
    });

    return [stateRound, stateGlobal, updatedMessages, endTurn, toolState];
  }

  /**
   * Processes initial conversation round.
   * @returns Tuple of [round state, global state, messages, completion flag, tool state]
   */
  protected async process(): Promise<
    [AgentStateRound, AgentStateGlobal, any[], boolean, ToolState]
  > {
    // Initialize input files list
    const inputFiles = [
      this.agentConfig.inputFile,
      ...(this.agentConfig.inputFiles || []),
    ];
    const toolState = new ToolState();

    // Initialize state and messages
    const currRound = 0;
    const stateGlobal = new AgentStateGlobal();

    this.logger.debug(`Processing round ${currRound}`);

    return this.withRoundGroup(`r${currRound}`, async (roundGroupId) => {
      const extraMedia: string[] = [];
      if (this.modelHandler.capabilities.supportsVision) {
        if (
          this.agentConfig.mediaFile &&
          !toolState.mediaFiles.includes(this.agentConfig.mediaFile)
        ) {
          extraMedia.push(this.agentConfig.mediaFile);
        }
        if (this.agentConfig.mediaFiles) {
          extraMedia.push(...this.agentConfig.mediaFiles);
        }
      }

      await this.latexMediaManager.processInputFiles(
        inputFiles,
        toolState,
        this.agentConfig.toolConfig,
        this.modelHandler.capabilities.supportsVision,
        extraMedia,
        roundGroupId,
      );

      const messages: any[] = [];

      // Set up initial prompts
      const promptBuilder = this.getPromptBuilder();
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();

      let prefixWithStats = userPrefix;
      if (toolState.texcountStats) {
        prefixWithStats = `${toolState.texcountStats}${userPrefix}`;
      }

      // Write prompt to file if debug setting is enabled
      const shouldSaveInputPrompt = getConfig<boolean>(
        'debug.saveInputPrompt',
        false,
      );
      if (shouldSaveInputPrompt) {
        const promptPath = await writePromptToXml(
          systemPrompt,
          prefixWithStats,
          userRequest,
          this.agentConfig.inputFile,
          this.agentConfig.agent,
          this.executionId,
        );
        this.logger.info(
          `Saved input prompt to ${promptPath}`,
          roundGroupId,
          MESSAGE_TYPES.DEFAULT,
        );
      }

      // Initialize messages with prompts
      const initialMessages = await this.modelHandler.initializeMessages(
        prefixWithStats,
        userRequest,
        toolState.mediaFiles,
        systemPrompt,
      );
      messages.push(...initialMessages);

      // Handle prefill
      const prefill = await promptBuilder.buildPrefill(currRound);
      toolState.updateAccumulatedOutput(prefill);

      const stateRound = new AgentStateRound(currRound);
      return this.runRoundPipeline(
        currRound,
        stateRound,
        stateGlobal,
        toolState,
        messages,
        prefill,
        this.outputFile[currRound],
        roundGroupId,
      );
    });
  }

  /**
   * Processes a follow-up conversation round.
   * @returns Tuple of [round state, global state, messages, completion flag]
   */
  protected async reflect(
    stateGlobal: AgentStateGlobal,
    messages: any[],
    toolState: ToolState,
    currRound: number = 1,
  ): Promise<[AgentStateRound, AgentStateGlobal, any[], boolean, ToolState]> {
    this.logger.debug(`Processing round ${currRound}`);

    return this.withRoundGroup(`r${currRound}`, async (roundGroupId) => {
      // Handle output file processing
      if (this.agentConfig.outputFiles) {
        await this._handleToolStateForOutput(
          this.agentConfig.outputFiles,
          currRound,
          toolState,
        );
      } else {
        // Handle single output file from previous round
        const outputFiles = this.outputHandler.ensureRound(currRound - 1);
        if (outputFiles.length > 0) {
          await this._handleToolStateForOutput(
            [outputFiles[0]],
            currRound,
            toolState,
          );
        }
      }

      // Initialize round
      const stateRound = new AgentStateRound(currRound);

      // Prepare round message
      const promptBuilder = this.getPromptBuilder();
      const userRequestReflect =
        await promptBuilder.buildReflectPrompt(currRound);
      let userMessage = userRequestReflect ? `${userRequestReflect}\n` : '';
      if (toolState.texcountStats) {
        userMessage = `${toolState.texcountStats}${userMessage}`;
      }

      // Only proceed if there's actual content
      if (!userMessage.trim()) {
        return [stateRound, stateGlobal, messages, true, toolState];
      }

      const roundMessages = await this.modelHandler.createRoundMessages(
        messages,
        userMessage,
        toolState.mediaFiles,
      );

      // Handle prefill for round
      const prefill = await promptBuilder.buildPrefill(currRound);
      toolState.updateAccumulatedOutput(prefill);

      return this.runRoundPipeline(
        currRound,
        stateRound,
        stateGlobal,
        toolState,
        roundMessages,
        prefill,
        this.outputFile[currRound],
        roundGroupId,
      );
    });
  }

  private async runRound(
    currRound: number,
    stateGlobal: AgentStateGlobal,
    messages: any[],
    toolState: ToolState,
  ): Promise<[AgentStateRound, AgentStateGlobal, any[], boolean, ToolState]> {
    if (currRound === 0) {
      return await this.process();
    }
    return await this.reflect(stateGlobal, messages, toolState, currRound);
  }

  /**
   * Main execution method that processes inputs and generates outputs.
   */
  public async run(): Promise<void> {
    await this.startRunGroup();

    try {
      await this.init(this.runGroupId, { createGroup: true });
      this.promptBuilder = undefined;
      await this.initializeClient();

      let stateGlobal = new AgentStateGlobal();
      let messages: any[] = [];
      let continueRounds = true;

      const totalRounds = this.getNumberOfRounds();
      for (let currRound = 0; currRound < totalRounds; currRound++) {
        if (this.isInterrupted) {
          break;
        }

        if (currRound > 0 && !continueRounds) {
          break;
        }

        this.userVars.CURRENT_ROUND = currRound;
        const toolState = new ToolState();
        const [stateRound, updatedGlobal, newMessages, endTurn, usedToolState] =
          await this.runRound(currRound, stateGlobal, messages, toolState);
        this.roundStates.push(stateRound);
        this.toolStates.push(usedToolState);
        stateGlobal = updatedGlobal;
        messages = newMessages;
        continueRounds = endTurn;
        stateGlobal.incrementRounds();
      }

      this.endRunGroup('stopped');
    } catch (error) {
      this.endRunGroup('error');
      throw error;
    } finally {
      this.cleanup();
    }
  }

  /**
   * Updates tool state based on output files.
   */
  private async _handleToolStateForOutput(
    outputFiles: string[],
    currRound: number,
    toolState: ToolState,
  ): Promise<void> {
    await this.latexMediaManager.processOutputFiles(
      outputFiles,
      toolState,
      this.agentConfig.toolConfig,
      this.modelHandler.capabilities.supportsVision,
      this.logger.getActiveGroupId(),
    );
  }
}
