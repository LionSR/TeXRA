// Standard library imports
import * as path from 'path';
import * as fs from 'fs';

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

// Local imports - utilities
import {
  readFile,
  writeFile,
  appendFile,
  fileExists,
} from '../utils/workspaceFileUtils';
import {
  renderPrompt,
  getListOfFiles,
  getFirstKCharsFromDocument,
  writePromptToXml,
  getXmlFormatFromFiles,
} from '../utils/promptUtils';
import {
  applyReplacements,
  getReplacementsByCategory,
  getAllReplacements,
  getAllReplacementsRegex,
} from '../utils/replacementUtils';
import { checkForMassiveRepetition } from '../utils/repetitionUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting, AgentPrompt } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ToolState } from './ToolState';
import { ModelHandler } from './ModelHandler';
import { OutputHandler } from './OutputHandler';

const K_SLICE = 200;
const SEPARATOR =
  '\n------------------------------------------------------------\n';

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
  protected outputFile: [string, string];
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
    this.outputFile = ['', ''];
    this.outputFiles = { 0: [], 1: [] };
    this.baseFiles = this.agentConfig.outputFiles || [
      this.agentConfig.inputFile,
    ];
    this.userVars = {};

    // Check scratchpad usage
    this.useScratchpad =
      this.agentSetting.prefills?.includes('<scratchpad>') || false;

    // Set output files
    this.outputFile[0] = this.getOutputFile(0);
    this.outputFile[1] = this.getOutputFile(1);

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
  public async init(): Promise<void> {
    this.logger.info(SEPARATOR);
    this.logger.debug(`AgentConfig: ${JSON.stringify(this.agentConfig)}\n`);
    this.logger.debug(`AgentSetting: ${JSON.stringify(this.agentSetting)}\n`);
    this.logger.debug(
      `ModelConfig: ${JSON.stringify(this.modelHandler.config)}\n`,
    );

    this.userVars = await this.getUserVars();
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
    // Build user variables incrementally with clear categories
    this.logger.info(`Obtaining dynamic variables...`);
    const userVars: Record<string, any> = {};
    Object.assign(userVars, this.getBasicVars());
    Object.assign(userVars, await this.getFileVars());
    Object.assign(userVars, await this.getRequiredFileVars());
    Object.assign(userVars, await this.getPatternBasedFileVars());
    Object.assign(userVars, this.getOutputFilesOrder());
    Object.assign(userVars, this.getToolFlags());
    return userVars;
  }

  /**
   * Collects basic model and instruction variables.
   * @returns Core variables about model capabilities and instructions
   */
  private getBasicVars(): Record<string, any> {
    return {
      MODEL: this.agentConfig.model,
      INSTRUCTION: this.agentConfig.instruction,
      IS_OPENAI_MODEL: this.modelHandler.isOpenai,
      IS_ANTHROPIC_MODEL: this.modelHandler.isAnthropic,
      IS_GOOGLE_MODEL: this.modelHandler.isGoogle,
    };
  }

  /**
   * Processes input, reference, and auxiliary files into variables.
   * @returns File content and metadata variables for prompts
   */
  private async getFileVars(): Promise<Record<string, any>> {
    const userVars: Record<string, any> = {};

    const allInputFiles = [
      this.agentConfig.inputFile,
      ...(this.agentConfig.inputFiles?.filter(Boolean) || []),
    ];
    const allReferenceFiles = [
      this.agentConfig.referenceFile,
      ...(this.agentConfig.referenceFiles?.filter(Boolean) || []),
    ];
    const allAuxiliaryFiles = [
      this.agentConfig.auxiliaryFile,
      ...(this.agentConfig.auxiliaryFiles?.filter(Boolean) || []),
    ];

    // Handle single files
    const singleFileMappings = {
      INPUT: this.agentConfig.inputFile,
      REFERENCE: this.agentConfig.referenceFile,
      AUXILIARY: this.agentConfig.auxiliaryFile,
      EDITED: this.agentConfig.editedFile,
    };

    for (const [prefix, filePath] of Object.entries(singleFileMappings)) {
      userVars[`${prefix}_FILE`] = filePath;
      userVars[`${prefix}_CONTENT`] = filePath
        ? await readFile(filePath)
        : null;
    }

    // Handle file collections
    const collectionMappings = {
      INPUT: [
        this.agentConfig.inputFiles?.filter(Boolean),
        allInputFiles.filter(Boolean),
      ],
      REFERENCE: [
        this.agentConfig.referenceFiles?.filter(Boolean),
        allReferenceFiles.filter(Boolean),
      ],
      AUXILIARY: [
        this.agentConfig.auxiliaryFiles?.filter(Boolean),
        allAuxiliaryFiles.filter(Boolean),
      ],
    };

    for (const [prefix, [additionalFiles, allFiles]] of Object.entries(
      collectionMappings,
    )) {
      const additionalXml = additionalFiles
        ? await getXmlFormatFromFiles(additionalFiles as string[])
        : null;
      const allXml = allFiles
        ? await getXmlFormatFromFiles(allFiles as string[])
        : null;

      userVars[`ADDITIONAL_${prefix}S`] = additionalXml;
      userVars[`ALL_${prefix}S`] = allXml;
      userVars[`LIST_OF_ALL_${prefix}S`] = getListOfFiles(allFiles as string[]);
    }

    return userVars;
  }

  /**
   * Processes required files specified in agent settings.
   * @returns Variables containing required file contents
   */
  private async getRequiredFileVars(): Promise<Record<string, any>> {
    const userVars: Record<string, any> = {};

    // Add variables for required files
    if (this.agentSetting.requiredFiles) {
      for (const [varName, filePath] of Object.entries(
        this.agentSetting.requiredFiles,
      )) {
        if (filePath) {
          try {
            const fileContent = await readFile(filePath);
            userVars[`${varName}_FILE`] = filePath;
            userVars[`${varName}_CONTENT`] = fileContent;
            this.logger.info(
              `Found from [requiredFiles] the [VAR '${varName}']: ${filePath}`,
            );
          } catch (err) {
            this.logger.warn(
              `[Required file] ${filePath} not found from [VAR '${varName}']`,
            );
          }
        }
      }
    }

    // Add variables for internal required files (from prompt directory)
    if (this.agentSetting.requiredFilesInternal) {
      for (const [varName, filePath] of Object.entries(
        this.agentSetting.requiredFilesInternal,
      )) {
        const fullPath = path.join(this.agentPath, filePath);
        try {
          const fileContent = await fs.promises.readFile(fullPath, 'utf-8');
          userVars[`${varName}_FILE`] = fullPath;
          userVars[`${varName}_CONTENT`] = fileContent;
          this.logger.info(
            `Found from [requiredFilesInternal] the [VAR '${varName}']: ${fullPath}`,
          );
        } catch (err) {
          this.logger.warn(
            `[Required file internal] ${fullPath} not found from [VAR '${varName}']`,
          );
        }
      }
    }

    return userVars;
  }

  /**
   * Processes files matching patterns in agent settings.
   * @returns Variables from pattern-matched files
   */
  private async getPatternBasedFileVars(): Promise<Record<string, any>> {
    const userVars: Record<string, any> = {};

    // Handle pattern-based file mappings if defined in settings
    if (this.agentSetting.filePatternsContain) {
      for (const patternConfig of this.agentSetting.filePatternsContain) {
        const pattern = patternConfig.pattern.toLowerCase();
        const varName = patternConfig.varName;
        const categories = patternConfig.categories;

        // Search in specified categories
        for (const category of categories) {
          // Get the value from AgentConfig using dictionary-style access
          const categoryValue = (this.agentConfig as any)[category];

          if (category.endsWith('File')) {
            // Single file categories
            if (
              categoryValue &&
              categoryValue.toLowerCase().includes(pattern)
            ) {
              try {
                const fileContent = await readFile(categoryValue);
                userVars[`${varName}_FILE`] = categoryValue;
                userVars[`${varName}_CONTENT`] = fileContent;
                this.logger.info(
                  `Found from [Pattern '${pattern}'] the [VAR '${varName}']: ${categoryValue}`,
                );
              } catch (err) {
                this.logger.warn(
                  `File ${categoryValue} not found from [Pattern '${pattern}']`,
                );
              }
            }
          } else if (category.endsWith('Files')) {
            // Multiple file categories
            if (categoryValue) {
              for (const file of categoryValue) {
                if (file.toLowerCase().includes(pattern)) {
                  try {
                    const fileContent = await readFile(file);
                    userVars[`${varName}_FILE`] = file;
                    userVars[`${varName}_CONTENT`] = fileContent;
                    this.logger.info(
                      `Found from [Pattern '${pattern}'] the [VAR '${varName}']: ${file}`,
                    );
                    break; // Stop after first match
                  } catch (err) {
                    this.logger.warn(
                      `File ${file} not found from [Pattern '${pattern}']`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }

    return userVars;
  }

  /**
   * Determines order of output file processing.
   * @returns Variables controlling output file ordering
   */
  private getOutputFilesOrder(): Record<string, any> {
    const userVars: Record<string, any> = {};

    // Handle output files order - use defaultOutputFiles if no outputFiles specified
    if (
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 0
    ) {
      userVars.OUTPUT_FILES_ORDER = this.agentConfig.outputFiles.join(', ');
    } else if (
      Array.isArray(this.agentSetting.defaultOutputFiles) &&
      this.agentSetting.defaultOutputFiles.length > 0
    ) {
      // If no outputFiles specified but defaultOutputFiles exists in settings
      this.agentConfig.outputFiles = this.agentSetting.defaultOutputFiles;
      userVars.OUTPUT_FILES_ORDER =
        this.agentSetting.defaultOutputFiles.join(', ');
    }

    return userVars;
  }

  /**
   * Collects tool-specific configuration flags.
   * @returns Variables for tool behavior control
   */
  private getToolFlags(): Record<string, any> {
    return {
      AUTO_EXTRACT_FIGURE: this.agentConfig.toolConfig.autoExtractFigure,
      AUTO_EXTRACT_TIKZ_FIGURE:
        this.agentConfig.toolConfig.autoExtractTikzFigure,
      INCLUDE_TEX_COUNT: this.agentConfig.toolConfig.attachTeXCount,
      USE_PREFILL_FROM_INPUT: this.agentConfig.toolConfig.usePrefillFromInput,
      PRINT_INPUT_PROMPT: this.agentConfig.toolConfig.printInputPrompt,
    };
  }

  /**
   * Manages single response cycle with model interaction.
   * @param messages Current conversation messages
   * @param stateRound Current round state
   * @param stateGlobal Global conversation state
   * @param toolState Tool-specific state
   * @param outputFile Current output file path
   * @returns Updated states and completion flag
   */
  private async processResponseCycle(
    messages: any[],
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    toolState: ToolState,
    outputFile: string,
  ): Promise<[AgentStateRound, AgentStateGlobal, ToolState, boolean]> {
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
      const responseObject = await this.modelHandler.createResponse(
        this.client,
        messages,
        this.agentSetting.temperature || 0.0,
        systemPrompt,
        this.agentSetting.endTag,
      );
      const responseTime = (Date.now() - startTime) / 1000;
      stateRound.updateResponseTime(responseTime);
      this.logger.info(`Response time: ${responseTime.toFixed(2)}s`);

      // Extract and validate response
      const [newResponse, responseUsage, stopReason] =
        this.modelHandler.extractResponse(
          responseObject,
          this.agentSetting.endTag,
        );

      this.logger.debug(`Stop reason: ${stopReason}`);
      this.logger.debug(`Token usage: ${JSON.stringify(responseUsage)}`);

      // Compute statistics and update states
      const APIUsage = this.modelHandler.computeResponseUsage(
        responseUsage,
        responseTime,
      );

      stateRound.updateTokenCounts(APIUsage);
      stateGlobal.updateFromCurrRound(stateRound);
      // this.logger.debug(`stateRound: ${JSON.stringify(stateRound)}`);

      // Early exit for repetition
      const repetitionResult = checkForMassiveRepetition(
        toolState.lastResponse,
        newResponse,
      );
      if (repetitionResult.massiveRepetitionDetected) {
        this.logger.error(`The new response is: ${newResponse}`);
        this.logger.error(
          `Massive repetition detected - skipping this response`,
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
        this.logger.info(`Creating new file: ${outputFile}`);
        await writeFile(outputFile, processedResponse);
      } else {
        this.logger.info(`Appending to existing file: ${outputFile}`);
        await appendFile(outputFile, bestConnector + processedResponse);
      }

      // Log response boundaries
      this.logger.debug(`Response preview:`);
      this.logger.debug(
        `First ${K_SLICE} chars:\n${processedResponse.slice(0, K_SLICE)}`,
      );
      this.logger.debug(
        `Last ${K_SLICE} chars:\n${processedResponse.slice(-K_SLICE)}`,
      );

      // Update message content
      this.modelHandler.updateMessageContent(
        messages,
        bestConnector,
        processedResponse,
        toolState,
      );

      // Check stop conditions
      const [shouldEndTurn, shouldStop] = this.modelHandler.checkStopConditions(
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
      );

      // Check if model should continue generating
      if (
        this.modelHandler.shouldContinue(
          stopReason,
          processedResponse,
          this.agentSetting,
        )
      ) {
        this.logger.debug(
          `Should continue - adding continuation message to conversation`,
        );
        this.modelHandler.addContinueMessage(
          messages,
          stateRound,
          toolState,
          this.agentSetting,
          this.agentConfig,
        );
        continue;
      }
    }

    return [stateRound, stateGlobal, toolState, endTurn];
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

  /**
   * Processes completion of conversation round.
   */
  private async handleRoundCompletion(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number,
  ): Promise<void> {
    this.logger.debug(`State global: ${JSON.stringify(stateGlobal)}`);

    await this.handleOutput(
      stateRound,
      stateGlobal,
      outputFile,
      endTurn,
      currRound,
    );
    const inputInfo = `inputFile ${this.agentConfig.inputFile} and/or inputFiles ${this.agentConfig.inputFiles}`;
    this.logger.info(
      `Processed ${inputInfo}. The round ${currRound} output was saved as ${outputFile}`,
    );
    this.logger.info(`Completed round ${currRound}`);
  }

  /**
   * Processes output files for current round.
   * @returns Array of processed output file paths
   */
  protected async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number = 0,
  ): Promise<string[]> {
    // Print statistics at the end of each round
    this.outputHandler.printStatistics(stateGlobal);

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
    const toolState = ToolState.initialize();

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
        this.agentConfig.figureFile &&
        !toolState.figureFiles.includes(this.agentConfig.figureFile)
      ) {
        toolState.addFigureFiles([this.agentConfig.figureFile]);
      }
      if (this.agentConfig.figureFiles) {
        toolState.addFigureFiles(this.agentConfig.figureFiles);
      }

      if (this.agentConfig.toolConfig.autoExtractFigure) {
        const extractedFigures = await extractFigurePathsFromLatex(
          this.agentConfig.inputFile,
        );
        if (extractedFigures) {
          this.logger.info(
            `Extracted ${extractedFigures.length} figures from ${this.agentConfig.inputFile}. Figures: ${extractedFigures.join(', ')}`,
          );
          toolState.addFigureFiles(extractedFigures);
        }
      }

      if (this.agentConfig.toolConfig.autoExtractTikzFigure) {
        for (const inputFile of inputFiles) {
          const extractedTikzFigures =
            await extractAndCompileTikzPicturesWithLabels(inputFile);
          if (extractedTikzFigures) {
            toolState.addFigureFiles(extractedTikzFigures);
          }
        }
      }
    }

    // Initialize state and messages
    const currRound = 0;
    this.logger.info(SEPARATOR);
    this.logger.info(`Processing round ${currRound}`);
    const stateGlobal = AgentStateGlobal.initialize();

    const messages: any[] = [];

    // Set up initial prompts
    const [systemPrompt, userRequest, userPrefix] = await Promise.all([
      renderPrompt(this.agentPrompt.systemPrompt, this.userVars),
      renderPrompt(this.agentPrompt.userRequest, this.userVars),
      renderPrompt(this.agentPrompt.userPrefix, this.userVars),
    ]);

    // logger.debug(CHANNEL, `User prefix: ${userPrefix}`);
    // logger.debug(CHANNEL, `User request: ${userRequest}`);
    // logger.debug(CHANNEL, `System prompt: ${systemPrompt}`);

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
      toolState.figureFiles,
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
      );

    const stateRound = AgentStateRound.initialize(currRound);
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
      );
      finalEndTurn = newEndTurn;

      // Handle output and logging
      await this.handleRoundCompletion(
        updatedStateRound,
        updatedStateGlobal,
        this.outputFile[0],
        finalEndTurn,
        currRound,
      );

      this.logger.debug(`stateGlobal: ${JSON.stringify(updatedStateGlobal)}`);

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
    );

    return [stateRound, stateGlobal, updatedMessages, finalEndTurn, toolState];
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
    this.logger.info(SEPARATOR);
    this.logger.info(`Processing round ${currRound}`);
    const stateRound = AgentStateRound.initialize(currRound);

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
      return [stateRound, stateGlobal, messages, true];
    }

    const reflectionMessages = await this.modelHandler.createReflectionMessages(
      messages,
      userMessage,
      toolState.figureFiles,
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
      );

      // Handle output and logging
      await this.handleRoundCompletion(
        updatedStateRound,
        updatedStateGlobal,
        this.outputFile[1],
        newEndTurn,
        currRound,
      );

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
    );

    return [stateRound, stateGlobal, updatedMessages, endTurn];
  }

  /**
   * Executes complete agent conversation cycle.
   * Manages initial processing and optional reflection rounds.
   */
  public async run(): Promise<void> {
    try {
      // Initialize client before starting
      await this.initializeClient();

      this.logger.info(SEPARATOR);
      const [stateRound, stateGlobal, messages, endTurn, toolState] =
        await this.process();
      this.logger.info(`Round 0 completed\n`);
      this.logger.info(SEPARATOR);

      // Check for interruption before reflection
      if (
        !this.isInterrupted &&
        this.agentConfig.toolConfig.reflect &&
        endTurn
      ) {
        const toolStateReflection = ToolState.initialize();
        await this.reflect(stateGlobal, messages, toolStateReflection);
        this.logger.info(`Round 1 completed\n`);
        this.logger.info(SEPARATOR);
      }
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
          toolState.addFigureFiles(extractedTikzFigures);
        }
      }
    }
  }

  /**
   * Processes output files with figure extraction and validation.
   * @param outputFile Current output file path
   * @param currRound Current round number
   */
  protected async processOutputFiles(
    outputFile: string,
    currRound: number,
  ): Promise<void> {
    // logger.debug(CHANNEL, `processOutputFiles called with outputFile: ${outputFile}, currRound: ${currRound}`);
    // logger.debug(CHANNEL, `this.agentConfig.outputFiles type: ${typeof this.agentConfig.outputFiles}`);
    // logger.debug(CHANNEL, `this.agentConfig.outputFiles value: ${JSON.stringify(this.agentConfig.outputFiles)}`);

    if (
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 0
    ) {
      // Multiple output files case
      this.logger.debug(`Processing multiple outputs for ${outputFile}`);
      this.logger.debug(`Output files: ${this.agentConfig.outputFiles}`);

      // if the agentType is CoT, we need to process the output files
      // Then I realize that in fact it does not make sense to have multiple output files
      // while to extract it from a single tex file. So in this case, we really need to
      // use XML and use XML splitting to get the output files.
      // Which would be different than the single output file case below.

      const processedFiles =
        await this.outputHandler.processMultipleXmlOutputs(outputFile);
      if (processedFiles.length > 0) {
        await this.outputHandler.handleMultipleOutputs(processedFiles);
        this.outputHandler.outputFiles[currRound] = processedFiles;
        await this.outputHandler.replaceInputCommands(
          this.baseFiles,
          processedFiles,
        );
      }
    } else {
      // Single output file case
      this.logger.debug(`Processing single output for ${outputFile}`);
      let processedFile = outputFile;
      if (this.agentSetting.agentType === 'CoT') {
        processedFile =
          await this.outputHandler.processSingleXmlOutput(outputFile);
      }
      if (processedFile) {
        await this.outputHandler.handleSingleOutput(processedFile);
        this.outputHandler.outputFiles[currRound] = [processedFile];
      }
    }

    await this.outputHandler.handleLatexdiff(currRound);
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
}
