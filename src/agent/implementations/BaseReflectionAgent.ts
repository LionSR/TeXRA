// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - log

// Local imports - latex utils
import { LatexMediaManager } from '@latex';

import { bus } from '@eventBus/ProgressEventBus';

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

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
} from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import { runResponseCycle } from '@agent/core/ResponseCycle';
import type { IModelHandler } from '@agent/modelHandlers';
import type { ToolDefinition } from '@model';
import { OutputHandler, NamedOutputFile, IOutputHandler } from '@agent/output';
import { BaseAgent } from '@agent/implementations/BaseAgent';

// System imports - common utilities
import { getConfig } from '@utils/config';

// Shared constants
import { K_SLICE } from '@utils/config';

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
    bus.emit('addOutputFiles', {
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
        ] = await runResponseCycle(
          {
            modelHandler: this.modelHandler,
            agentSetting: this.agentSetting,
            agentConfig: this.agentConfig,
            agentPrompt: this.agentPrompt,
            userVars: this.userVars,
            logger: this.logger,
            client: this.client,
            checkInterruption: () => this.checkInterruption(),
            setAbortController: (ctrl) => {
              this.abortController = ctrl;
            },
          },
          updatedMessages,
          stateRound,
          stateGlobal,
          toolState,
          this.outputFile[currRound],
          round0GroupId,
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
        ] = await runResponseCycle(
          {
            modelHandler: this.modelHandler,
            agentSetting: this.agentSetting,
            agentConfig: this.agentConfig,
            agentPrompt: this.agentPrompt,
            userVars: this.userVars,
            logger: this.logger,
            client: this.client,
            checkInterruption: () => this.checkInterruption(),
            setAbortController: (ctrl) => {
              this.abortController = ctrl;
            },
          },
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
