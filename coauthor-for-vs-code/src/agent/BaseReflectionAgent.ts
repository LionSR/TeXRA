// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - latex utils
import {
  extractAndCompileTikzPicturesWithLabels,
  extractFigurePathsFromLatex,
  bestConnectionMethod,
  getTexCountStats,
  ConnectionResult,
} from '../latex';

// Local imports - utilities
import {
  readFile,
  writeFile,
  appendFile,
  fileExists,
} from '../utils/fileUtils';
import {
  renderPrompt,
  getListOfFiles,
  getFirstKCharsFromDocument,
  writePromptToXml,
  getXmlFormatFromFiles,
} from '../utils/promptUtils';
import {
  getReplacementsByCategory,
  applyReplacementRegex,
  applyReplacements,
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

const CHANNEL = 'Agent';
logger.initializeLogging(CHANNEL);

/**
 * Abstract base class for reflection chain agents.
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
  protected outputHandler: OutputHandler;

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

    logger.debug(CHANNEL, `AgentConfig: ${JSON.stringify(this.agentConfig)}\n`);
    logger.debug(
      CHANNEL,
      `AgentSetting: ${JSON.stringify(this.agentSetting)}\n`,
    );

    logger.debug(
      CHANNEL,
      `ModelConfig: ${JSON.stringify(this.modelHandler.config)}\n`,
    );
    logger.debug(CHANNEL, `ModelHandler: ${this.modelHandler}\n`);

    // Initialize basic attributes
    this.outputFile = ['', ''];
    this.outputFiles = { 0: [], 1: [] };
    this.baseFiles = [];

    this.setup();
    const userVars = this.getUserVars();
    this.outputHandler = new OutputHandler(
      this.agentSetting,
      this.agentConfig,
      this.modelHandler,
      this.logId,
    );
  }

  /**
   * Get output file path for the current round.
   */
  protected abstract getOutputFile(currRound: number): string;

  /**
   * Set up the agent for processing.
   */
  protected setup(): void {
    // Initialize base files and logging
    this.baseFiles = this.agentConfig.outputFiles || [
      this.agentConfig.inputFile,
    ];
    logger.info(CHANNEL, `Processing file: ${this.agentConfig.inputFile}`);

    // Initialize client and check scratchpad usage
    this.client = this.modelHandler.getClient();

    this.useScratchpad =
      this.agentSetting.prefills?.includes('<scratchpad>') || false;
    this.outputFile[0] = this.getOutputFile(0);
    this.outputFile[1] = this.getOutputFile(1);

    // Initialize logging and database entry
    // TODO: Implement logging to SQLite database
    this.logId = 0;
  }

  /**
   * Get basic user variables common across agents.
   */
  protected async getUserVars(): Promise<Record<string, any>> {
    // Build user variables incrementally with clear categories
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
   * Get basic model and instruction variables.
   */
  private getBasicVars(): Record<string, any> {
    return {
      MODEL: this.agentConfig.model,
      MODEL_LIKES_TO_ASK_FOR_CONFIRMATION:
        this.modelHandler.capabilities.likesToAskForConfirmation,
      INSTRUCTION: this.agentConfig.instruction,
      IS_OPENAI_MODEL: this.modelHandler.isOpenai,
      IS_ANTHROPIC_MODEL: this.modelHandler.isAnthropic,
      IS_GOOGLE_MODEL: this.modelHandler.isGoogle,
    };
  }

  /**
   * Get input, reference, and auxiliary file variables.
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
   * Get variables from required files specified in agent settings.
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
            logger.info(
              CHANNEL,
              `Found from [requiredFiles] the [VAR '${varName}']: ${filePath}`,
            );
          } catch (err) {
            logger.warn(
              CHANNEL,
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
        const fullPath = `${this.agentPath}/${filePath}`;
        try {
          const fileContent = await readFile(fullPath);
          userVars[`${varName}_FILE`] = fullPath;
          userVars[`${varName}_CONTENT`] = fileContent;
          logger.info(
            CHANNEL,
            `Found from [requiredFilesInternal] the [VAR '${varName}']: ${fullPath}`,
          );
        } catch (err) {
          logger.warn(
            CHANNEL,
            `[Required file internal] ${fullPath} not found from [VAR '${varName}']`,
          );
        }
      }
    }

    return userVars;
  }

  /**
   * Get variables from pattern-based file mappings specified in agent settings.
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
            if (categoryValue && pattern in categoryValue.toLowerCase()) {
              try {
                const fileContent = await readFile(categoryValue);
                userVars[`${varName}_FILE`] = categoryValue;
                userVars[`${varName}_CONTENT`] = fileContent;
                logger.info(
                  CHANNEL,
                  `Found from [Pattern '${pattern}'] the [VAR '${varName}']: ${categoryValue}`,
                );
              } catch (err) {
                logger.warn(
                  CHANNEL,
                  `File ${categoryValue} not found from [Pattern '${pattern}']`,
                );
              }
            }
          } else if (category.endsWith('Files')) {
            // Multiple file categories
            if (categoryValue) {
              for (const file of categoryValue) {
                if (pattern in file.toLowerCase()) {
                  try {
                    const fileContent = await readFile(file);
                    userVars[`${varName}_FILE`] = file;
                    userVars[`${varName}_CONTENT`] = fileContent;
                    logger.info(
                      CHANNEL,
                      `Found from [Pattern '${pattern}'] the [VAR '${varName}']: ${file}`,
                    );
                    break; // Stop after first match
                  } catch (err) {
                    logger.warn(
                      CHANNEL,
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
   * Get variables for output files order.
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
   * Get variables related to tool usage flags.
   */
  private getToolFlags(): Record<string, any> {
    return {
      AUTO_EXTRACT_FIGURE: this.agentConfig.toolConfig.autoExtractFigure,
      AUTO_EXTRACT_TIKZ_FIGURE:
        this.agentConfig.toolConfig.autoExtractTikzFigure,
      AUTO_EXTRACT_TIKZ_FIGURE_REFLECT:
        this.agentConfig.toolConfig.autoExtractTikzFigureReflect,
      INCLUDE_TEX_COUNT: this.agentConfig.toolConfig.includeTexCount,
      AUTO_CONFIRMATION: this.agentConfig.toolConfig.autoConfirmation,
      USE_PREFILL_FROM_INPUT: this.agentConfig.toolConfig.usePrefillFromInput,
      PRINT_INPUT_PROMPT: this.agentConfig.toolConfig.printInputPrompt,
      USE_OPENROUTER: this.agentConfig.toolConfig.useOpenRouter,
    };
  }

  /**
   * Process a single response cycle.
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
      const exists = await fileExists(outputFile);
      const startTime = Date.now();
      const systemPrompt = await renderPrompt(
        this.agentPrompt.systemPrompt,
        this.getUserVars(),
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
      logger.info(CHANNEL, `Response time: ${responseTime.toFixed(2)}s`);

      // Extract and validate response
      const [newResponse, responseUsage, stopReason] =
        this.modelHandler.extractResponse(
          responseObject,
          this.agentSetting.endTag,
          this.agentConfig.toolConfig.autoConfirmation,
        );

      logger.info(CHANNEL, `Stop reason: ${stopReason}`);
      logger.info(CHANNEL, `Token usage: ${JSON.stringify(responseUsage)}`);

      // Compute statistics and update states
      const APIUsage = this.modelHandler.computeResponseUsage(
        responseUsage,
        responseTime,
      );
      stateRound.updateTokenCounts(APIUsage);
      stateGlobal.updateFromCurrRound(stateRound);
      logger.debug(CHANNEL, `State round: ${JSON.stringify(stateRound)}`);
      logger.debug(CHANNEL, `State global: ${JSON.stringify(stateGlobal)}`);

      // Early exit for repetition
      const repetitionResult = checkForMassiveRepetition(
        toolState.lastResponse,
        newResponse,
      );
      if (repetitionResult.massiveRepetitionDetected) {
        logger.error(CHANNEL, `The new response is: ${newResponse}`);
        logger.error(
          CHANNEL,
          'Massive repetition detected - skipping this response',
        );
        break;
      }

      // Chain response processing operations
      let processedResponse = newResponse;
      if (
        this.modelHandler.capabilities.likesToAskForConfirmation &&
        this.agentConfig.toolConfig.autoConfirmation
      ) {
        processedResponse = applyReplacementRegex(
          processedResponse,
          getReplacementsByCategory('autoConfirmation'),
        );
      }
      processedResponse = applyReplacements(
        processedResponse,
        getReplacementsByCategory('all'),
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
        logger.debug(CHANNEL, `Creating new file: ${outputFile}`);
        await writeFile(outputFile, processedResponse);
      } else {
        logger.debug(CHANNEL, `Appending to existing file: ${outputFile}`);
        await appendFile(outputFile, bestConnector + processedResponse);
      }

      // Log response boundaries
      logger.info(CHANNEL, 'Response preview:');
      logger.debug(
        CHANNEL,
        `First ${K_SLICE} chars: ${processedResponse.slice(0, K_SLICE)}`,
      );
      logger.debug(
        CHANNEL,
        `Last ${K_SLICE} chars: ${processedResponse.slice(-K_SLICE)}`,
      );

      // Update message content
      this.modelHandler.updateMessageContent(
        messages,
        bestConnector,
        processedResponse,
        toolState,
        this.agentConfig.toolConfig.autoConfirmation,
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
      logger.info(
        CHANNEL,
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
        logger.info(
          CHANNEL,
          'Should continue - adding continuation message to conversation',
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
   * Get prefill content for the current round.
   */
  private getPrefillForRound(currRound: number): string {
    const prefill =
      currRound < (this.agentSetting.prefills?.length || 0)
        ? this.agentSetting.prefills![currRound]
        : this.agentSetting.prefills?.[0] || '';
    return prefill;
  }

  /**
   * Handle output and logging for round completion.
   */
  private handleRoundCompletion(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number,
  ): void {
    this.handleOutput(stateRound, stateGlobal, outputFile, endTurn, currRound);
    const inputInfo = `input file ${this.agentConfig.inputFile} and/or input files ${this.agentConfig.inputFiles}`;
    logger.info(
      CHANNEL,
      `\n\nProcessed ${inputInfo}. The round ${currRound} output was saved as ${outputFile}`,
    );
    logger.info(CHANNEL, `Completed round ${currRound}`);
  }

  /**
   * Handle output for the given round.
   */
  protected async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number = 0,
  ): Promise<string[]> {
    // TODO: Implement logging to SQLite database
    // if (this.logId !== null) {
    //   updateLogStatistics(this.logId, stateGlobal, stateRound, currRound);
    // }
    // updateLogOutputFiles(this.logId, outputFile, this.outputHandler.outputFiles[currRound]);

    // Process output files
    await this.processOutputFiles(outputFile, currRound);

    return this.outputHandler.outputFiles[currRound] || [];
  }

  /**
   * Process the input files and generate output.
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
    if (this.agentConfig.toolConfig.includeTexCount) {
      // TODO: Implement texcount functionality
      // toolState.texcountStats = await getTexCountStats(inputFiles);
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
    logger.info(CHANNEL, `\n\nProcessing round ${currRound}`);
    const stateGlobal = AgentStateGlobal.initialize();

    const messages: any[] = [];

    // Set up initial prompts
    const userVars = await this.getUserVars();
    const [systemPrompt, userRequest, userPrefix] = await Promise.all([
      renderPrompt(this.agentPrompt.systemPrompt, userVars),
      renderPrompt(this.agentPrompt.userRequest, userVars),
      renderPrompt(this.agentPrompt.userPrefix, userVars),
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
      this.handleRoundCompletion(
        updatedStateRound,
        updatedStateGlobal,
        this.outputFile[0],
        finalEndTurn,
        currRound,
      );

      return [
        updatedStateRound,
        updatedStateGlobal,
        updatedMessages,
        finalEndTurn,
        updatedToolState,
      ];
    }

    // Handle output and logging for early termination
    this.handleRoundCompletion(
      stateRound,
      stateGlobal,
      this.outputFile[0],
      finalEndTurn,
      currRound,
    );

    return [stateRound, stateGlobal, updatedMessages, finalEndTurn, toolState];
  }

  /**
   * Process reflection round.
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
    logger.info(CHANNEL, `\n\nProcessing round ${currRound}`);
    const stateRound = AgentStateRound.initialize(currRound);

    // Prepare reflection message
    const userVars = await this.getUserVars();
    const userRequestReflect = await renderPrompt(
      this.agentPrompt.userReflect,
      userVars,
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
      this.handleRoundCompletion(
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
    this.handleRoundCompletion(
      stateRound,
      stateGlobal,
      this.outputFile[1],
      endTurn,
      currRound,
    );

    return [stateRound, stateGlobal, updatedMessages, endTurn];
  }

  /**
   * Run the agent processing pipeline.
   */
  public async run(): Promise<void> {
    const [stateRound, stateGlobal, messages, endTurn, toolState] =
      await this.process();

    if (this.agentConfig.reflect && endTurn) {
      // Create a new ToolState for reflection round
      const reflectionToolState = ToolState.initialize();
      await this.reflect(stateGlobal, messages, reflectionToolState);
    }
  }

  /**
   * Handle output file processing.
   */
  private async _handleToolStateForOutput(
    outputFiles: string[],
    currRound: number,
    toolState: ToolState,
  ): Promise<void> {
    if (this.agentConfig.toolConfig.includeTexCount) {
      toolState.texcountStats = await getTexCountStats(outputFiles);
    }

    if (
      this.modelHandler.capabilities.supportsVision &&
      this.agentConfig.toolConfig.autoExtractTikzFigureReflect
    ) {
      for (const outputFile of outputFiles) {
        logger.debug(CHANNEL, `Extracting TikZ figures from ${outputFile}`);
        const extractedTikzFigures =
          await extractAndCompileTikzPicturesWithLabels(outputFile);
        if (extractedTikzFigures) {
          toolState.addFigureFiles(extractedTikzFigures);
        }
      }
    }
  }

  /**
   * Process output files for the current round.
   * Handles both single and multiple output file cases, including:
   * - Processing outputs
   * - Handling file operations
   * - Managing output file tracking
   * - Handling LaTeX diff if needed
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
      logger.debug(CHANNEL, `Processing multiple outputs for ${outputFile}`);
      logger.debug(CHANNEL, `Output files: ${this.agentConfig.outputFiles}`);
      const processedFiles =
        await this.outputHandler.processMultipleOutputs(outputFile);
      await this.outputHandler.handleMultipleOutputs(processedFiles);
      this.outputHandler.outputFiles[currRound] = processedFiles;
      await this.outputHandler.replaceInputCommands(
        this.baseFiles,
        processedFiles,
      );
    } else {
      // Single output file case
      logger.debug(CHANNEL, `Processing single output for ${outputFile}`);
      const processedFile =
        await this.outputHandler.processSingleOutput(outputFile);
      await this.outputHandler.handleSingleOutput(processedFile);
      this.outputHandler.outputFiles[currRound] = [processedFile];
    }

    await this.outputHandler.handleLatexDiff(currRound);
  }
}
