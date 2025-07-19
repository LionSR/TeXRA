// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - log

// Local imports - latex utils
import { bestConnectionMethod, LatexMediaManager } from '@latex';

import { emitProgress } from '@eventBus/ProgressEventBus';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import {
  renderPrompt,
  getFirstKCharsFromDocument,
  writePromptToXml,
} from '@agent/utils/promptUtils';

import {
  getSystemPromptWithRules,
  getPrefillForRound,
} from '@agent/utils/promptHelpers';

// Local imports - UI

import replacementEngine from '@replacement/engine';
import { checkForMassiveRepetition } from '@agent/utils/text/repetitionUtils';
import xmlUtils from '@utils/text/xmlUtils';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentSetting, AgentPrompt } from '@agent/core/AgentDataclass';
import { AgentType } from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import type { IModelHandler } from '@agent/modelHandlers';
import type { ToolDefinition } from '@model';
import { OutputHandler, NamedOutputFile, IOutputHandler } from '@agent/output';
import { messageToSkeleton } from '@agent/utils/messageSkeletonUtils';
import { BaseAgent } from '@agent/implementations/BaseAgent';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// System imports - common utilities
import { getConfig } from '@utils/config';

// Shared constants
import { K_SLICE, REPETITION_DETECTION_THRESHOLD } from '@utils/config';

/**
 * Abstract base class for agents that support multi-turn reflection and refinement.
 * Provides core functionality for processing inputs, managing state, and handling outputs
 * across multiple conversation rounds.
 */
export abstract class BaseReflectionAgent extends BaseAgent {
  /** File paths for each round's raw model output. */
  protected outputFile: string[];
  protected outputFiles: { [key: number]: string[] };
  protected baseFiles: string[];
  protected useScratchpad: boolean = false;
  protected logId: number = 0;
  /** Handler for output file processing and validation. */
  protected outputHandler: IOutputHandler;
  protected latexMediaManager: LatexMediaManager;

  constructor(
    modelHandler: IModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ) {
    super(modelHandler, agentConfig, agentSetting, agentPrompt, agentPath);

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
      this.modelHandler,
      this.logId,
      this.baseFiles,
      this.logger,
    );

    this.latexMediaManager = new LatexMediaManager(this.logger);
  }

  /**
   * Generates output file path for specified conversation round.
   */
  protected abstract getOutputFile(currRound: number): string;

  /**
   * Returns the configured number of conversation rounds.
   */
  protected getNumberOfRounds(): number {
    return this.agentSetting.rounds ?? 2;
  }

  /**
   * Manages single response cycle with model interaction.
   * @param messages Current conversation messages
   * @param stateRound Current round state
   * @param stateGlobal Global conversation state
   * @param toolState Tool-specific state
   * @param outputFile Current output file path
   * @param roundGroupId Optional parent round group ID
   * @returns Updated states and completion flag
   */
  private async processResponseCycle(
    messages: any[],
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    toolState: ToolState,
    outputFile: string,
    roundGroupId?: string,
  ): Promise<[AgentStateRound, AgentStateGlobal, ToolState, boolean]> {
    // Use the round group identifier for logging this cycle
    const taskGroupId = roundGroupId;

    try {
      let endTurn = false;
      while (!endTurn) {
        // Check for interruption before each cycle
        if (await this.checkInterruption()) {
          break;
        }

        const exists = await WorkspaceFS.exists(outputFile);
        const startTime = Date.now();
        const systemPrompt = await getSystemPromptWithRules(
          this.agentPrompt.systemPrompt,
          this.userVars,
        );

        // Save message object to file for debugging if enabled in settings
        const shouldSaveMessageObjects = getConfig(
          'debug.saveMessageObjects',
          false,
        );
        if (shouldSaveMessageObjects) {
          const outputFileBaseName = outputFile.replace('.xml', '');
          const debugFilePath = `${outputFileBaseName}_cont${stateRound.continuationCount}.json`;
          try {
            await WorkspaceFS.writeFile(
              debugFilePath,
              JSON.stringify(messages, null, 2),
            );
            this.logger.info(
              `Saved message object to ${debugFilePath}`,
              taskGroupId,
            );
          } catch (error) {
            this.logger.error(
              `Failed to save message object: ${error}`,
              taskGroupId,
            );
          }
        }

        this.abortController = new AbortController();
        let responseObject;
        try {
          responseObject = await this.modelHandler.createResponse(
            this.client,
            messages,
            this.agentSetting.temperature || 0.0,
            systemPrompt,
            this.agentSetting.endTag,
            this.abortController.signal,
            this.modelHandler.capabilities.supportsFunctionCalling
              ? this.agentSetting.tools
              : undefined,
          );
        } finally {
          this.abortController = null;
        }
        if (!responseObject) {
          this.logger.warn(
            'Model response was aborted or returned no data; output may be incomplete.',
            taskGroupId,
          );
          break;
        }
        const responseTime = (Date.now() - startTime) / 1000;
        stateRound.updateResponseTime(responseTime);
        this.logger.debug(
          `Response time: ${responseTime.toFixed(2)}s`,
          taskGroupId,
        );

        // Extract and validate response
        const [newResponse, responseUsage, stopReason] =
          this.modelHandler.extractResponse(
            responseObject,
            this.agentSetting.endTag,
          );

        this.logger.debug(`Stop reason: ${stopReason}`, taskGroupId);
        this.logger.debug(
          `Token usage: ${JSON.stringify(responseUsage)}`,
          taskGroupId,
        );

        // Extract thinking blocks directly from the response object
        // This updates toolState with all thinking/redacted_thinking blocks
        // and returns content of the first thinking block for logging (if any)
        const thinkingContent = this.modelHandler.processThinkingBlock(
          responseObject,
          taskGroupId,
          toolState,
        );

        // If thinking content was extracted, format and log it first
        if (thinkingContent) {
          const formatted = await xmlUtils.formatContent(thinkingContent);
          this.logger.info(formatted, taskGroupId, MESSAGE_TYPES.THINKING);

          // Note: The complete thinking blocks (including signatures) have already been
          // stored in toolState.thinkingBlocks by the processThinkingBlock method
        }

        // Extract scratchpad content directly from the response text
        const scratchpad = await xmlUtils.extractScratchpad(
          newResponse,
          'scratchpad',
        );
        if (scratchpad) {
          this.logger.info(scratchpad, taskGroupId, MESSAGE_TYPES.SCRATCHPAD);
        }
        // this has a potential bug if <scratchpad> is included in the prefill

        // Compute statistics and update states
        const APIUsage = this.modelHandler.computeResponseUsage(
          responseUsage,
          responseTime,
        );

        stateRound.updateTokenCounts(APIUsage);
        stateGlobal.updateFromCurrRound(stateRound);

        // Early exit for repetition
        const repetitionResult = checkForMassiveRepetition(
          toolState.lastResponse,
          newResponse,
        );
        if (repetitionResult.massiveRepetitionDetected) {
          this.logger.error(
            `The new response is (first ${REPETITION_DETECTION_THRESHOLD} chars): ${newResponse.substring(0, REPETITION_DETECTION_THRESHOLD)}`,
            taskGroupId,
          );
          this.logger.error(
            `Massive repetition detected - skipping this response`,
            taskGroupId,
          );

          // Debug information - print message skeleton to help diagnose the problem
          this.logger.error(
            `Message structure when repetition detected:`,
            taskGroupId,
          );
          this.logger.error(
            JSON.stringify(messageToSkeleton(messages), null, 2),
            taskGroupId,
          );
          break;
        }

        // Chain response processing operations
        const processedResponse = replacementEngine.applyAll(newResponse);

        toolState.updateLastResponse(processedResponse);

        // Process response connection with proper slicing
        const result = await bestConnectionMethod(
          toolState.lastResponse.slice(-K_SLICE),
          processedResponse.slice(0, K_SLICE),
        );
        const bestConnector = result.connector;

        // Update state and file atomically
        toolState.updateAccumulatedOutput(
          toolState.accumulatedOutput + bestConnector + processedResponse,
        );

        // Write or append to output file
        if (!exists) {
          this.logger.debug(`Creating new file: ${outputFile}`, taskGroupId);
          await WorkspaceFS.writeFile(outputFile, processedResponse);
        } else {
          this.logger.debug(
            `Appending to existing file: ${outputFile}`,
            taskGroupId,
          );
          await WorkspaceFS.appendFile(
            outputFile,
            bestConnector + processedResponse,
          );
        }

        // Log response boundaries
        this.logger.debug(`Response preview:`, taskGroupId);
        this.logger.debug(
          `First ${K_SLICE} chars:\n${processedResponse.slice(0, K_SLICE)}`,
          taskGroupId,
        );
        this.logger.debug(
          `Last ${K_SLICE} chars:\n${processedResponse.slice(-K_SLICE)}`,
          taskGroupId,
        );

        // Update message content
        // maybe we should separate this into the case of with or without support for assistant prefill since they have different logic...
        if (this.modelHandler.capabilities.supportsAssistantPrefill) {
          this.modelHandler.updateMessageContentWithPrefill(
            messages,
            bestConnector,
            processedResponse,
            toolState,
          );
        } else {
          this.modelHandler.updateMessageContentWithoutPrefill(
            messages,
            bestConnector,
            processedResponse,
            toolState,
          );
        }

        // Check stop conditions
        const [shouldEndTurn, shouldStop] =
          this.modelHandler.checkStopConditions(
            stopReason,
            processedResponse,
            stateRound,
            stateGlobal,
            this.agentSetting,
          );
        endTurn = shouldEndTurn;
        if (shouldStop) {
          break;
        }

        // Handle continuation
        stateRound.incrementContinuation();
        this.logger.info(
          `Starting continuation #${stateRound.continuationCount}`,
          taskGroupId,
        );

        // Check if model should continue generating
        // why is this not included in the checkStopConditions function?
        if (
          this.modelHandler.shouldContinue(
            stopReason,
            processedResponse,
            this.agentSetting,
          )
        ) {
          this.logger.debug(
            `Should continue - adding continuation message to conversation`,
            taskGroupId,
          );
          if (this.modelHandler.capabilities.supportsAssistantPrefill) {
            this.modelHandler.addContinueMessageWithPrefill(
              messages,
              stateRound,
              toolState,
              this.agentSetting,
              this.agentConfig,
            );
            continue;
          } else {
            this.modelHandler.addContinueMessageWithoutPrefill(
              messages,
              stateRound,
              toolState,
              this.agentSetting,
              this.agentConfig,
            );
            continue;
          }
        }
      }

      return [stateRound, stateGlobal, toolState, endTurn];
    } catch (error) {
      throw error;
    }
  }

  /**
   * Processes completion of conversation round.
   */
  private async handleRoundCompletion(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number,
    roundGroupId?: string,
  ): Promise<void> {
    try {
      // Instead of creating a new group, use the round group directly
      // this.logger.debug(
      //   `State global: ${JSON.stringify(stateGlobal)}`,
      //   roundGroupId,
      // );

      await this.handleOutput(
        stateRound,
        stateGlobal,
        outputFile,
        endTurn,
        currRound,
        roundGroupId,
      );

      this.logger.debug(`Completed round ${currRound}`, roundGroupId);
    } catch (error) {
      throw error;
    }

    const fileInfos = await this.outputHandler.gatherOutputFileInfo(currRound);

    // Validate expected outputs if this is the end of the turn
    if (endTurn) {
      try {
        await this.outputHandler.validateExpectedOutputs(
          outputFile,
          currRound,
          roundGroupId,
        );
        this.logger.debug(
          `Expected outputs validated for round ${currRound}`,
          roundGroupId,
        );
      } catch (error) {
        this.logger.error(
          `Expected output validation failed after round ${currRound}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          roundGroupId,
        );
      }
    }
    emitProgress('addOutputFiles', {
      stream: this.logger.channelId,
      filesByRound: { [currRound]: fileInfos },
    });
  }

  /**
   * Processes output files for current round.
   * This method orchestrates the overall output processing flow with clear separation of concerns:
   * 1. Statistics handling via printStatistics
   * 2. LaTeX diff operations via handleLatexdiffofOutput (only when endTurn is true)
   *
   * The actual file processing is handled separately in processOutputFiles.
   *
   * @returns Array of processed output file paths
   */
  protected async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number = 0,
    processGroupId?: string,
  ): Promise<string[]> {
    // Print statistics at the end of each round
    await this.outputHandler.printStatistics(stateGlobal, processGroupId);

    // If this is the end of a turn, handle latexdiff operations as a separate step
    if (
      endTurn &&
      this.outputHandler.outputFiles[currRound] &&
      this.outputHandler.outputFiles[currRound].length > 0
    ) {
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

    return this.outputHandler.outputFiles[currRound] || [];
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

    // Create a dedicated group for Round 0, as a child of the main run group
    const round0GroupId = await this.logger.startGroup(
      `r${currRound}`,
      undefined,
      this.runGroupId, // Use the runGroupId from the class as the parent
    );

    try {
      // Handle prefill from input if enabled
      if (this.agentConfig.toolConfig.usePrefillFromInput) {
        toolState.firstKCharsFromInput = await getFirstKCharsFromDocument(
          this.agentConfig.inputFile,
          K_SLICE,
        );
      }

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
        round0GroupId,
      );

      const messages: any[] = [];

      // Set up initial prompts
      const [systemPrompt, userRequest, userPrefix] = await Promise.all([
        getSystemPromptWithRules(this.agentPrompt.systemPrompt, this.userVars),
        renderPrompt(this.agentPrompt.userRequest, this.userVars),
        renderPrompt(this.agentPrompt.userPrefix, this.userVars),
      ]);

      let prefixWithStats = userPrefix;
      if (toolState.texcountStats) {
        prefixWithStats = `${toolState.texcountStats}${userPrefix}`;
      }

      // Write prompt to file if requested
      if (this.agentConfig.toolConfig.printInputPrompt) {
        await writePromptToXml(
          systemPrompt,
          prefixWithStats,
          userRequest,
          this.agentConfig.inputFile,
          this.agentConfig.agent,
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
      const prefill = getPrefillForRound(this.agentSetting.prefills, currRound);
      toolState.updateAccumulatedOutput(prefill);

      // Initialize output and handle prefill
      const [endTurn, updatedMessages] =
        await this.modelHandler.initializeOutputAndPrefill(
          this.agentConfig,
          this.agentSetting,
          messages,
          toolState,
          this.outputFile[currRound],
          prefill,
          round0GroupId,
        );

      const stateRound = new AgentStateRound(currRound);
      let finalEndTurn = endTurn;

      if (!endTurn) {
        const [
          updatedStateRound,
          updatedStateGlobal,
          updatedToolState,
          newEndTurn,
        ] = await this.processResponseCycle(
          updatedMessages,
          stateRound,
          stateGlobal,
          toolState,
          this.outputFile[currRound],
          round0GroupId, // Pass the round group ID to processResponseCycle
        );
        finalEndTurn = newEndTurn;

        // Handle output and logging
        await this.handleRoundCompletion(
          updatedStateRound,
          updatedStateGlobal,
          this.outputFile[currRound],
          finalEndTurn,
          currRound,
          round0GroupId, // Pass the round group ID
        );

        this.logger.debug(
          `stateGlobal: ${JSON.stringify(updatedStateGlobal)}`,
          round0GroupId,
        );

        // End the round group
        this.logger.endGroup(round0GroupId, 'stopped');

        return [
          updatedStateRound,
          updatedStateGlobal,
          updatedMessages,
          finalEndTurn,
          updatedToolState,
        ];
      }

      // Handle output and logging for early termination
      await this.handleRoundCompletion(
        stateRound,
        stateGlobal,
        this.outputFile[currRound],
        finalEndTurn,
        currRound,
        round0GroupId, // Pass the round group ID
      );

      // End the round group
      this.logger.endGroup(round0GroupId, 'stopped');

      return [
        stateRound,
        stateGlobal,
        updatedMessages,
        finalEndTurn,
        toolState,
      ];
    } catch (error) {
      // End the round group with error status in case of exceptions
      this.logger.endGroup(round0GroupId, 'error');
      throw error;
    }
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
  ): Promise<[AgentStateRound, AgentStateGlobal, any[], boolean]> {
    this.logger.debug(`Processing round ${currRound}`);

    // Create a dedicated group for round 1, as a child of the main run group
    const round1GroupId = await this.logger.startGroup(
      `r${currRound}`,
      undefined,
      this.runGroupId,
    );

    try {
      // Handle output file processing
      if (this.agentConfig.outputFiles) {
        await this._handleToolStateForOutput(
          this.agentConfig.outputFiles,
          currRound,
          toolState,
        );
      } else {
        // Handle single output file from previous round
        const outputFiles = this.outputHandler.outputFiles[currRound - 1];
        if (outputFiles && outputFiles.length > 0) {
          await this._handleToolStateForOutput(
            [outputFiles[0]],
            currRound,
            toolState,
          );
        }
      }

      if (this.agentConfig.toolConfig.usePrefillFromInput) {
        toolState.firstKCharsFromInput = await getFirstKCharsFromDocument(
          this.agentConfig.inputFile,
          K_SLICE,
        );
      }

      // Initialize round
      const stateRound = new AgentStateRound(currRound);

      // Prepare round message
      const userRequestReflect = await renderPrompt(
        this.agentPrompt.userReflect,
        this.userVars,
      );
      let userMessage = userRequestReflect ? `${userRequestReflect}\n` : '';
      if (toolState.texcountStats) {
        userMessage = `${toolState.texcountStats}${userMessage}`;
      }

      // Only proceed if there's actual content
      if (!userMessage.trim()) {
        this.logger.endGroup(round1GroupId, 'stopped');
        return [stateRound, stateGlobal, messages, true];
      }

      const roundMessages = await this.modelHandler.createRoundMessages(
        messages,
        userMessage,
        toolState.mediaFiles,
      );

      // Handle prefill for round
      const prefill = getPrefillForRound(this.agentSetting.prefills, currRound);
      toolState.updateAccumulatedOutput(prefill);

      const [endTurn, updatedMessages] =
        await this.modelHandler.initializeOutputAndPrefill(
          this.agentConfig,
          this.agentSetting,
          roundMessages,
          toolState,
          this.outputFile[currRound],
          prefill,
          round1GroupId,
        );

      if (!endTurn) {
        const [
          updatedStateRound,
          updatedStateGlobal,
          updatedToolState,
          newEndTurn,
        ] = await this.processResponseCycle(
          updatedMessages,
          stateRound,
          stateGlobal,
          toolState,
          this.outputFile[currRound],
          round1GroupId,
        );

        // Handle output and logging
        await this.handleRoundCompletion(
          updatedStateRound,
          updatedStateGlobal,
          this.outputFile[currRound],
          newEndTurn,
          currRound,
          round1GroupId,
        );

        this.logger.endGroup(round1GroupId, 'stopped');
        return [
          updatedStateRound,
          updatedStateGlobal,
          updatedMessages,
          newEndTurn,
        ];
      }

      // Handle output and logging for early termination
      await this.handleRoundCompletion(
        stateRound,
        stateGlobal,
        this.outputFile[currRound],
        endTurn,
        currRound,
        round1GroupId,
      );

      this.logger.endGroup(round1GroupId, 'stopped');
      return [stateRound, stateGlobal, updatedMessages, endTurn];
    } catch (error) {
      // End the round group with error status in case of exceptions
      this.logger.endGroup(round1GroupId, 'error');
      throw error;
    }
  }

  /**
   * Main execution method that processes inputs and generates outputs.
   */
  public async run(): Promise<void> {
    // Create a dedicated run group for this agent execution
    this.runGroupId = await this.logger.startGroup(
      `Run: ${this.agentConfig.agent}@${this.agentConfig.model}`,
    );

    try {
      // Initialize agent variables within the run group
      await this.init(this.runGroupId);

      // Initialize client before starting
      await this.initializeClient();

      const [stateRound, stateGlobal, messages, endTurn, toolState] =
        await this.process();
      this.logger.debug(`Round 0 completed\n`, this.runGroupId);

      // Check for interruption before next round
      if (
        !this.isInterrupted &&
        this.agentConfig.toolConfig.reflect &&
        endTurn
      ) {
        const toolStateReflection = new ToolState();
        await this.reflect(stateGlobal, messages, toolStateReflection);
        this.logger.debug(`Round 1 completed\n`, this.runGroupId);
      }

      // End the run group with success status
      this.logger.endGroup(this.runGroupId, 'stopped');
    } catch (error) {
      // End the run group with error status
      if (this.runGroupId) {
        this.logger.endGroup(this.runGroupId, 'error');
      }
      throw error;
    } finally {
      // Always clean up, whether execution completed or was interrupted
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

  /**
   * Processes output files from XML or direct input.
   * This method focuses solely on extracting and processing output files.
   * It does NOT perform any latexdiff operations - those are handled separately
   * in the handleOutput method via handleLatexdiffofOutput.
   *
   * @param outputFile Path to the output file to process
   * @param currRound Current round number
   * @param processGroupId Optional process group ID for logging
   */
}
