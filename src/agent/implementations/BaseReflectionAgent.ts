// Standard library imports
import * as path from 'path';

// Third-party imports
// (none needed)

// Local imports - log

// Local imports - latex utils
import {
  extractAndCompileTikzPicturesWithLabels,
  extractFigurePathsFromLatex,
  getTeXCountStats,
  compileLatex2Pdf,
} from '@latex';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import {
  renderPrompt,
  getFirstKCharsFromDocument,
  writePromptToXml,
} from '@utils/promptUtils';
import { loadTexraRules } from '@frontend/files/rules';

// Local imports - agent components
import { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
} from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import { ModelHandler } from '@agent/modelHandlers';
import { OutputHandler } from '@agent/runtime/OutputHandler';
import { BaseAgent } from '@agent/implementations/BaseAgent';

// System imports - common utilities
import { getConfig } from '@utils/config';
import { ResponseProcessor, FileHandler, RoundManager } from '@agent/runtime';

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
  protected outputHandler: OutputHandler;
  protected responseProcessor: ResponseProcessor;
  protected fileHandler: FileHandler;
  protected roundManager: RoundManager;

  constructor(
    modelHandler: ModelHandler,
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

    this.fileHandler = new FileHandler(
      this.outputHandler,
      this.agentSetting,
      this.agentConfig,
      this.modelHandler,
      this.logger,
      this.baseFiles,
    );
    this.responseProcessor = new ResponseProcessor(
      this.modelHandler,
      this.agentConfig,
      this.agentSetting,
      this.logger,
      this.getSystemPromptWithRules.bind(this),
      async () => this.checkInterruption(),
    );
    this.roundManager = new RoundManager(this.logger, this.fileHandler);
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
   * Combines the base system prompt with additional rules from `.texrarules`.
   */
  protected async getSystemPromptWithRules(): Promise<string> {
    const basePrompt = await renderPrompt(
      this.agentPrompt.systemPrompt,
      this.userVars,
    );
    const rules = await loadTexraRules();
    return rules ? `${basePrompt}\n${rules}` : basePrompt;
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
   * Processes output files for current round.
   * This method orchestrates the overall output processing flow with clear separation of concerns:
   * 1. Statistics handling via printStatistics
   * 2. LaTeX diff operations via handleLatexdiffofOutput (only when endTurn is true)
   *
   * The actual file processing is handled separately in processOutputFiles.
   *
   * @returns Array of processed output file paths
   */

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

        if (this.agentConfig.toolConfig.autoCompileInputPdf) {
          for (const inputFile of inputFiles) {
            if (!inputFile.toLowerCase().endsWith('.tex')) {
              continue;
            }
            const buildDir = path.join(path.dirname(inputFile), 'build');
            const compiled = await compileLatex2Pdf(
              inputFile,
              undefined,
              buildDir,
            );
            if (compiled) {
              const pdfFile = path.join(
                buildDir,
                path.basename(inputFile).replace(/\.tex$/, '.pdf'),
              );
              if (await WorkspaceFS.exists(pdfFile)) {
                this.logger.info(
                  `Compiled PDF for ${inputFile}: ${pdfFile}`,
                  round0GroupId,
                );
                toolState.addMediaFiles([pdfFile]);
              }
            }
          }
        }
      }

      const messages: any[] = [];

      // Set up initial prompts
      const [systemPrompt, userRequest, userPrefix] = await Promise.all([
        this.getSystemPromptWithRules(),
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
        ] = await this.responseProcessor.process(
          this.client,
          updatedMessages,
          stateRound,
          stateGlobal,
          toolState,
          this.outputFile[currRound],
          round0GroupId,
        );
        finalEndTurn = newEndTurn;

        // Handle output and logging
        await this.roundManager.completeRound(
          updatedStateRound,
          updatedStateGlobal,
          this.outputFile[currRound],
          finalEndTurn,
          currRound,
          round0GroupId,
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
      await this.roundManager.completeRound(
        stateRound,
        stateGlobal,
        this.outputFile[currRound],
        finalEndTurn,
        currRound,
        round0GroupId,
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
        await this.fileHandler.handleToolStateForOutput(
          this.agentConfig.outputFiles,
          toolState,
        );
      } else {
        const outputFiles = this.outputHandler.outputFiles[currRound - 1];
        if (outputFiles && outputFiles.length > 0) {
          await this.fileHandler.handleToolStateForOutput(
            [outputFiles[0]],
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
      const prefill = this.getPrefillForRound(currRound);
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
        ] = await this.responseProcessor.process(
          this.client,
          updatedMessages,
          stateRound,
          stateGlobal,
          toolState,
          this.outputFile[currRound],
          round1GroupId,
        );

        // Handle output and logging
        await this.roundManager.completeRound(
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
      await this.roundManager.completeRound(
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
}
