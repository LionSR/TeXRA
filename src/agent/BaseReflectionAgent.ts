// Standard library imports
import * as path from 'path';

// Third-party imports
// (none needed)

// Local imports - log
import { AgentLogger } from '../logger/AgentLogger';

// Local imports - latex utils
import {
  extractAndCompileTikzPicturesWithLabels,
  extractFigurePathsFromLatex,
  bestConnectionMethod,
  getTeXCountStats,
} from '../latex';
import { ProgressViewProvider } from '../progressView/ProgressViewProvider';
import { diff_match_patch } from 'diff-match-patch';

// Local imports - utilities
import {
  writeFile,
  appendFile,
  fileExists,
  readFile,
} from '../utils/workspaceFileUtils';
import {
  renderPrompt,
  getFirstKCharsFromDocument,
  writePromptToXml,
} from '../utils/promptUtils';
import {
  applyReplacements,
  getAllReplacements,
  getAllReplacementsRegex,
} from '../replacement/replacementUtils';
import { checkForMassiveRepetition } from '../utils/repetitionUtils';
import {
  extractAndLogScratchpad,
  formatAndLogContent,
} from '../utils/xmlUtils';
import { sleep } from '../utils/timeUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting, AgentPrompt, AgentType } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ToolState } from './ToolState';
import { ModelHandler } from './ModelHandler';
import { OutputHandler } from './OutputHandler';
import { messageToSkeleton } from './messageUtils';
import { buildUserVars } from './userVars';

// System imports - common utilities
import { getConfig } from '../utils/configUtils';

// Shared constants
import {
  K_SLICE,
  SHORT_SLEEP_MS,
  REPETITION_DETECTION_THRESHOLD,
} from '../utils/constants';

/**
 * Abstract base class for agents that support multi-turn reflection and refinement.
 * Provides core functionality for processing inputs, managing state, and handling outputs
 * across multiple conversation rounds.
 */
export abstract class BaseReflectionAgent {
  protected modelHandler: ModelHandler;
  protected agentConfig: AgentConfig;
  protected agentSetting: AgentSetting;
  protected agentPrompt: AgentPrompt;
  protected agentPath: string;
  /** File paths for each round's raw model output. */
  protected outputFile: string[];
  protected outputFiles: { [key: number]: string[] };
  protected baseFiles: string[];
  protected client: any;
  protected useScratchpad: boolean = false;
  protected logId: number = 0;
  protected logger: AgentLogger;
  /** Handler for output file processing and validation. */
  protected outputHandler: OutputHandler;
  /** Cached user variables to avoid recomputation */
  protected userVars: Record<string, any>;
  /** Group ID for the main run group, used as parent for subgroups */
  protected runGroupId?: string;
  private isInterrupted: boolean = false;

  // Static map to track running agents by their stream ID
  private static runningAgents: Map<string, BaseReflectionAgent> = new Map();

  /** Public getter for agent configuration */
  public get config(): AgentConfig {
    return this.agentConfig;
  }

  constructor(
    modelHandler: ModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ) {
    this.modelHandler = modelHandler;
    this.agentConfig = agentConfig;
    this.agentSetting = agentSetting;
    this.agentPrompt = agentPrompt;
    this.agentPath = agentPath;

    // Initialize logger with unique channel ID
    const channelId = this.getTaskId();
    this.logger = new AgentLogger(channelId);

    // Update model handler's logger
    this.modelHandler.setLogger(this.logger);

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
    this.userVars = {};

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

    // Register this agent instance
    BaseReflectionAgent.runningAgents.set(channelId, this);
  }

  /**
   * Initializes the client asynchronously.
   * Must be called before using any client operations.
   */
  protected async initializeClient(): Promise<void> {
    this.client = await this.modelHandler.getClient();
    // wait briefly to avoid rate limit issues
    await sleep(SHORT_SLEEP_MS);
  }

  /**
   * Gets unique task ID from output name override or input filename.
   * @returns Task ID string used for logging and output naming
   */
  private getTaskId(): string {
    const baseName = path.basename(
      this.agentConfig.outputNameOverride || this.agentConfig.inputFile,
    );
    // Use the potentially modified agent name (with _multiple suffix if applicable)
    const agentName =
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 1
        ? `${this.agentConfig.agent}_multiple`
        : this.agentConfig.agent;
    return `${agentName}@${this.agentConfig.model}: ${baseName}`;
  }

  /**
   * Initializes user variables that require async operations.
   * Must be called after constructor before using the agent.
   */
  public async init(parentGroupId?: string): Promise<void> {
    // Create an initialization group for better log organization
    const initGroupId = await this.logger.startGroup(
      `Initialization`,
      undefined,
      parentGroupId,
    );

    try {
      // Log configuration details in the initialization group
      this.logger.debug(
        `AgentConfig: ${JSON.stringify(this.agentConfig)}`,
        initGroupId,
      );
      this.logger.debug(
        `AgentSetting: ${JSON.stringify(this.agentSetting)}`,
        initGroupId,
      );
      this.logger.debug(
        `ModelConfig: ${JSON.stringify(this.modelHandler.config)}`,
        initGroupId,
      );

      // Initialize user variables
      this.userVars = await this.getUserVars();

      // End the initialization group with success status
      this.logger.endGroup(initGroupId, 'stopped');
    } catch (error) {
      // End the group with error status if initialization fails
      this.logger.endGroup(initGroupId, 'error');
      throw error;
    }
  }

  /**
   * Generates output file path for specified conversation round.
   */
  protected abstract getOutputFile(currRound: number): string;

  /**
   * Collects variables for prompt rendering from various sources.
   * @returns Combined dictionary of variables for prompt templates
   */
  protected async getUserVars(): Promise<Record<string, any>> {
    this.logger.debug(`Obtaining dynamic variables...`);
    return buildUserVars(
      this.agentConfig,
      this.agentSetting,
      this.agentPath,
      this.modelHandler,
      this.logger,
    );
  }

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
    // Create a response cycle group as a child of the round group if provided
    const responseCycleGroupId = roundGroupId
      ? await this.logger.startGroup(`Response Cycle`, undefined, roundGroupId)
      : undefined;

    try {
      let endTurn = false;
      while (!endTurn) {
        // Check for interruption before each cycle
        if (await this.checkInterruption()) {
          break;
        }

        const exists = await fileExists(outputFile);
        const startTime = Date.now();
        const systemPrompt = await renderPrompt(
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
            await writeFile(debugFilePath, JSON.stringify(messages, null, 2));
            this.logger.info(
              `Saved message object to ${debugFilePath}`,
              responseCycleGroupId,
            );
          } catch (error) {
            this.logger.error(
              `Failed to save message object: ${error}`,
              responseCycleGroupId,
            );
          }
        }

        const responseObject = await this.modelHandler.createResponse(
          this.client,
          messages,
          this.agentSetting.temperature || 0.0,
          systemPrompt,
          this.agentSetting.endTag,
        );
        const responseTime = (Date.now() - startTime) / 1000;
        stateRound.updateResponseTime(responseTime);
        this.logger.info(
          `Response time: ${responseTime.toFixed(2)}s`,
          responseCycleGroupId,
        );

        // Extract and validate response
        const [newResponse, responseUsage, stopReason] =
          this.modelHandler.extractResponse(
            responseObject,
            this.agentSetting.endTag,
          );

        // Extract thinking from XML tags in the response text
        this.extractAndLogScratchpad(
          newResponse,
          'scratchpad',
          responseCycleGroupId,
        );
        // this has a potential bug if <scratchpad> is included in the prefill

        this.logger.debug(`Stop reason: ${stopReason}`, responseCycleGroupId);
        this.logger.debug(
          `Token usage: ${JSON.stringify(responseUsage)}`,
          responseCycleGroupId,
        );

        // Extract thinking blocks directly from the response object
        // This updates toolState with all thinking/redacted_thinking blocks
        // and returns content of the first thinking block for logging (if any)
        const thinkingContent = this.modelHandler.processThinkingBlock(
          responseObject,
          responseCycleGroupId,
          toolState,
        );

        // If thinking content was extracted, format and log it
        if (thinkingContent) {
          formatAndLogContent(
            thinkingContent,
            this.logger,
            'Thinking',
            responseCycleGroupId,
          );

          // Note: The complete thinking blocks (including signatures) have already been
          // stored in toolState.thinkingBlocks by the processThinkingBlock method
        }

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
            responseCycleGroupId,
          );
          this.logger.error(
            `Massive repetition detected - skipping this response`,
            responseCycleGroupId,
          );

          // Debug information - print message skeleton to help diagnose the problem
          this.logger.error(
            `Message structure when repetition detected:`,
            responseCycleGroupId,
          );
          this.logger.error(
            JSON.stringify(messageToSkeleton(messages), null, 2),
            responseCycleGroupId,
          );
          break;
        }

        // Chain response processing operations
        let processedResponse = newResponse;
        processedResponse = applyReplacements(
          processedResponse,
          getAllReplacements(),
        ).trim();
        processedResponse = applyReplacements(
          processedResponse,
          getAllReplacementsRegex(),
        ).trim();
        processedResponse = applyReplacements(
          processedResponse,
          getAllReplacements(),
        ).trim();

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
          this.logger.info(
            `Creating new file: ${outputFile}`,
            responseCycleGroupId,
          );
          await writeFile(outputFile, processedResponse);
        } else {
          this.logger.info(
            `Appending to existing file: ${outputFile}`,
            responseCycleGroupId,
          );
          await appendFile(outputFile, bestConnector + processedResponse);
        }

        // Log response boundaries
        this.logger.debug(`Response preview:`, responseCycleGroupId);
        this.logger.debug(
          `First ${K_SLICE} chars:\n${processedResponse.slice(0, K_SLICE)}`,
          responseCycleGroupId,
        );
        this.logger.debug(
          `Last ${K_SLICE} chars:\n${processedResponse.slice(-K_SLICE)}`,
          responseCycleGroupId,
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
          responseCycleGroupId,
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
            responseCycleGroupId,
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

      if (responseCycleGroupId) {
        this.logger.endGroup(responseCycleGroupId, 'stopped');
      }

      return [stateRound, stateGlobal, toolState, endTurn];
    } catch (error) {
      if (responseCycleGroupId) {
        this.logger.endGroup(responseCycleGroupId, 'error');
      }
      throw error;
    }
  }

  /**
   * Gets prefill content for specified round.
   */
  private getPrefillForRound(currRound: number): string {
    const prefill =
      currRound < (this.agentSetting.prefills?.length || 0)
        ? this.agentSetting.prefills![currRound]
        : this.agentSetting.prefills?.[0] || '';
    return prefill;
  }

  private async computeDiffStats(
    baseFile: string,
    outputFile: string,
  ): Promise<{ added: number; removed: number }> {
    try {
      const [baseContent, outContent] = await Promise.all([
        readFile(baseFile),
        readFile(outputFile),
      ]);
      const dmp = new diff_match_patch();
      const diffs = dmp.diff_main(baseContent, outContent);
      let added = 0;
      let removed = 0;
      for (const [op, text] of diffs) {
        if (op === 1) {
          added += text.split(/\n/).length;
        } else if (op === -1) {
          removed += text.split(/\n/).length;
        }
      }
      return { added, removed };
    } catch {
      return { added: 0, removed: 0 };
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
      this.logger.debug(
        `State global: ${JSON.stringify(stateGlobal)}`,
        roundGroupId,
      );

      await this.handleOutput(
        stateRound,
        stateGlobal,
        outputFile,
        endTurn,
        currRound,
        roundGroupId,
      );

      const inputInfo = `inputFile ${this.agentConfig.inputFile} and/or inputFiles ${this.agentConfig.inputFiles}`;
      this.logger.info(
        `Processed ${inputInfo}. The round ${currRound} output was saved as ${outputFile}`,
        roundGroupId,
      );
      this.logger.info(`Completed round ${currRound}`, roundGroupId);
    } catch (error) {
      throw error;
    }

    const provider = ProgressViewProvider.getInstance();
    if (provider) {
      const roundOutputs = this.outputHandler.outputFiles[currRound] || [];

      // Map output files to their original base files
      const baseMap = this.outputHandler.createFileMapping(
        this.baseFiles,
        roundOutputs,
        'contains',
      );

      // Map output files to previous round files if available
      const prevMap =
        currRound > 0
          ? this.outputHandler.createFileMapping(
              this.outputHandler.outputFiles[currRound - 1] || [],
              roundOutputs,
              'basename',
              true,
            )
          : new Map<string, string>();

      const fileInfos = [] as any[];
      for (const file of roundOutputs) {
        const baseFile =
          Array.from(baseMap.entries()).find(([, out]) => out === file)?.[0] ||
          null;
        const prevFile =
          Array.from(prevMap.entries()).find(([, out]) => out === file)?.[0] ||
          null;
        let stats = { added: 0, removed: 0 };
        if (baseFile) {
          stats = await this.computeDiffStats(baseFile, file);
        }
        fileInfos.push({
          path: file,
          base: baseFile,
          prev: prevFile,
          ...stats,
        });
      }

      provider.addOutputFiles(this.logger.channelId, {
        [currRound]: fileInfos,
      });
    }
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
      // Pass the process group ID to maintain proper nesting in the log hierarchy
      await this.outputHandler.handleLatexdiffofOutput(
        currRound,
        processGroupId,
      );
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

    this.logger.info(`Processing round ${currRound}`);

    // Create a dedicated group for Round 0, as a child of the main run group
    const round0GroupId = await this.logger.startGroup(
      `Round ${currRound}: Initial Generation`,
      undefined,
      this.runGroupId, // Use the runGroupId from the class as the parent
    );

    try {
      // Handle tex count if enabled
      if (this.agentConfig.toolConfig.attachTeXCount) {
        toolState.texcountStats = await getTeXCountStats(inputFiles);
      }

      // Handle prefill from input if enabled
      if (this.agentConfig.toolConfig.usePrefillFromInput) {
        toolState.firstKCharsFromInput = await getFirstKCharsFromDocument(
          this.agentConfig.inputFile,
          K_SLICE,
        );
      }

      // Handle figure extraction for vision-capable models
      if (this.modelHandler.capabilities.supportsVision) {
        if (
          this.agentConfig.mediaFile &&
          !toolState.mediaFiles.includes(this.agentConfig.mediaFile)
        ) {
          toolState.addMediaFiles([this.agentConfig.mediaFile]);
        }
        if (this.agentConfig.mediaFiles) {
          toolState.addMediaFiles(this.agentConfig.mediaFiles);
        }

        if (this.agentConfig.toolConfig.autoExtractFigure) {
          const extractedFigures = await extractFigurePathsFromLatex(
            this.agentConfig.inputFile,
          );
          if (extractedFigures) {
            this.logger.info(
              `Extracted ${extractedFigures.length} figures from ${this.agentConfig.inputFile}. Figures: ${extractedFigures.join(', ')}`,
              round0GroupId,
            );
            toolState.addMediaFiles(extractedFigures);
          }
        }

        if (this.agentConfig.toolConfig.autoExtractTikzFigure) {
          for (const inputFile of inputFiles) {
            const extractedTikzFigures =
              await extractAndCompileTikzPicturesWithLabels(inputFile);
            if (extractedTikzFigures) {
              toolState.addMediaFiles(extractedTikzFigures);
            }
          }
        }
      }

      const messages: any[] = [];

      // Set up initial prompts
      const [systemPrompt, userRequest, userPrefix] = await Promise.all([
        renderPrompt(this.agentPrompt.systemPrompt, this.userVars),
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
      const prefill = this.getPrefillForRound(currRound);
      toolState.updateAccumulatedOutput(prefill);

      // Initialize output and handle prefill
      const [endTurn, updatedMessages] =
        await this.modelHandler.initializeOutputAndPrefill(
          this.agentConfig,
          this.agentSetting,
          messages,
          toolState,
          this.outputFile[0],
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
          this.outputFile[0],
          round0GroupId, // Pass the round group ID to processResponseCycle
        );
        finalEndTurn = newEndTurn;

        // Handle output and logging
        await this.handleRoundCompletion(
          updatedStateRound,
          updatedStateGlobal,
          this.outputFile[0],
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
        this.outputFile[0],
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
   * Processes reflection/refinement round.
   * @returns Tuple of [round state, global state, messages, completion flag]
   */
  protected async reflect(
    stateGlobal: AgentStateGlobal,
    messages: any[],
    toolState: ToolState,
    currRound: number = 1,
  ): Promise<[AgentStateRound, AgentStateGlobal, any[], boolean]> {
    this.logger.info(`Processing round ${currRound}`);

    // Create a dedicated group for Round 1 reflection, as a child of the main run group
    const round1GroupId = await this.logger.startGroup(
      `Round ${currRound}: Reflection`,
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
        // Handle single output file
        const outputFiles = this.outputHandler.outputFiles[0];
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

      // Initialize reflection round
      const stateRound = new AgentStateRound(currRound);

      // Prepare reflection message
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

      const reflectionMessages =
        await this.modelHandler.createReflectionMessages(
          messages,
          userMessage,
          toolState.mediaFiles,
        );

      // Handle prefill for reflection round
      const prefill = this.getPrefillForRound(currRound);
      toolState.updateAccumulatedOutput(prefill);

      const [endTurn, updatedMessages] =
        await this.modelHandler.initializeOutputAndPrefill(
          this.agentConfig,
          this.agentSetting,
          reflectionMessages,
          toolState,
          this.outputFile[1],
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
          this.outputFile[1],
          round1GroupId,
        );

        // Handle output and logging
        await this.handleRoundCompletion(
          updatedStateRound,
          updatedStateGlobal,
          this.outputFile[1],
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
        this.outputFile[1],
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
      this.logger.info(`Round 0 completed\n`, this.runGroupId);

      // Check for interruption before reflection
      if (
        !this.isInterrupted &&
        this.agentConfig.toolConfig.reflect &&
        endTurn
      ) {
        const toolStateReflection = new ToolState();
        await this.reflect(stateGlobal, messages, toolStateReflection);
        this.logger.info(`Round 1 completed\n`, this.runGroupId);
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
    if (this.agentConfig.toolConfig.attachTeXCount) {
      toolState.texcountStats = await getTeXCountStats(outputFiles);
    }

    if (
      this.modelHandler.capabilities.supportsVision &&
      this.agentConfig.toolConfig.autoExtractTikzFigure
    ) {
      for (const outputFile of outputFiles) {
        this.logger.debug(`Extracting TikZ figures from ${outputFile}`);
        const extractedTikzFigures =
          await extractAndCompileTikzPicturesWithLabels(outputFile);
        if (extractedTikzFigures) {
          toolState.addMediaFiles(extractedTikzFigures);
        }
      }
    }
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
  protected async processOutputFiles(
    outputFile: string,
    currRound: number,
    processGroupId?: string,
  ): Promise<void> {
    // Use provided process group ID or get the active group ID for proper nesting
    const activeGroupId = processGroupId || this.logger.getActiveGroupId();

    if (
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 0
    ) {
      // Multiple output files case
      this.logger.debug(
        `Processing multiple outputs for ${outputFile}`,
        activeGroupId,
      );
      this.logger.debug(
        `Output files: ${this.agentConfig.outputFiles}`,
        activeGroupId,
      );

      // if the agentType is CoT, we need to process the output files
      // Then I realize that in fact it does not make sense to have multiple output files
      // while to extract it from a single tex file. So in this case, we really need to
      // use XML and use XML splitting to get the output files.
      // Which would be different than the single output file case below.

      try {
        const processedFiles =
          await this.outputHandler.processMultipleXmlOutputs(outputFile);

        if (processedFiles && processedFiles.length > 0) {
          // Process output files - indent LaTeX files directly
          await this.outputHandler.indentLatexFiles(processedFiles);
          this.logger.debug(
            `Indented multiple output files: ${processedFiles.join(',')}`,
            activeGroupId,
          );

          this.outputHandler.outputFiles[currRound] = processedFiles;

          // Only attempt to replace input commands if we have valid base files
          if (this.baseFiles && this.baseFiles.length > 0) {
            await this.outputHandler.replaceInputCommands(
              this.baseFiles,
              processedFiles,
            );
          }
        } else {
          this.logger.warn(
            `No processed files were generated from ${outputFile}`,
            activeGroupId,
          );
          this.outputHandler.outputFiles[currRound] = [];
        }
      } catch (err) {
        this.logger.error(
          `Error processing output files: ${err instanceof Error ? err.message : String(err)}`,
          activeGroupId,
        );
        // Ensure we have an empty array at minimum to prevent undefined errors
        this.outputHandler.outputFiles[currRound] = [];
      }
    } else {
      // Single output file case
      this.logger.debug(
        `Processing single output for ${outputFile}`,
        activeGroupId,
      );

      try {
        let processedFile = outputFile;
        if (this.agentSetting.agentType === AgentType.CoT) {
          processedFile =
            await this.outputHandler.processSingleXmlOutput(outputFile);
        }

        if (processedFile) {
          // Process output file - indent LaTeX file directly
          await this.outputHandler.indentLatexFile(processedFile);
          this.logger.debug(
            `Indented single output file: ${processedFile}`,
            activeGroupId,
          );

          this.outputHandler.outputFiles[currRound] = [processedFile];
        } else {
          this.logger.warn(
            `No processed file was generated from ${outputFile}`,
            activeGroupId,
          );
          this.outputHandler.outputFiles[currRound] = [];
        }
      } catch (err) {
        this.logger.error(
          `Error processing output file: ${err instanceof Error ? err.message : String(err)}`,
          activeGroupId,
        );
        this.outputHandler.outputFiles[currRound] = [];
      }
    }
  }

  /**
   * Interrupts the agent's execution
   */
  public interrupt(): void {
    this.isInterrupted = true;
    this.logger.info(
      'Agent execution interrupted by user. Note that already sent response might still return outputs but no more request messages will be sent.',
    );
  }

  /**
   * Checks if the agent should stop due to interruption
   */
  private checkInterruption(): boolean {
    if (this.isInterrupted) {
      this.logger.info('Stopping due to user interruption');
      return true;
    }
    return false;
  }

  /**
   * Gets a running agent by its stream ID
   */
  public static getRunningAgent(
    streamId: string,
  ): BaseReflectionAgent | undefined {
    return BaseReflectionAgent.runningAgents.get(streamId);
  }

  /**
   * Removes a running agent from tracking
   */
  private cleanup(): void {
    const channelId = this.getTaskId();
    BaseReflectionAgent.runningAgents.delete(channelId);
  }

  /** Extracts and logs scratchpad content from output. */
  protected extractAndLogScratchpad(
    outputContent: string,
    thinkingTag: string = 'scratchpad',
    groupId?: string,
  ): void {
    extractAndLogScratchpad(outputContent, this.logger, thinkingTag, groupId);
  }
}
