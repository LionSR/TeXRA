// Local imports - agent

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
} from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { runResponseCycle } from '@agent/core/ResponseCycle';
import { ToolState } from '@agent/core/ToolState';
import { BaseAgent } from '@agent/implementations/BaseAgent';
import { ReflectionRoundNode } from '@agent/implementations/reflection/nodes/ReflectionRoundNode';
import type { IModelHandler } from '@agent/modelHandlers';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { OutputHandler, IOutputHandler } from '@agent/output';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { PromptBuilder } from '@agent/utils/PromptBuilder';
// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - log

// Local imports - latex utils
import { LatexMediaManager } from '@latex';

// System imports - common utilities

// Local imports - utilities
import { calculateTotalRounds } from '@agent/utils/roundUtils';
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
  protected promptBuilder?: PromptBuilder;
  public roundStates: AgentStateRound[] = [];
  public toolStates: ToolState[] = [];

  constructor(
    modelHandler: IModelHandler,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    executionId?: ExecutionId,
  ) {
    super(
      modelHandler,
      agentConfig,
      agentSetting,
      agentPrompt,
      agentPath,
      executionId,
    );

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
      this.agentPrompt.userReflect,
    );
  }

  /**
   * Processes completion of conversation round.
   */
  protected async handleRoundCompletion(
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

  private createRoundNode(): ReflectionRoundNode {
    return new ReflectionRoundNode({
      agentConfig: this.agentConfig,
      agentSetting: this.agentSetting,
      agentPrompt: this.agentPrompt,
      userVars: this.userVars,
      modelHandler: this.modelHandler,
      outputHandler: this.outputHandler,
      latexMediaManager: this.latexMediaManager,
      getPromptBuilder: () => this.getPromptBuilder(),
      logger: this.logger,
      handleRoundCompletion: (currRound, stateRound, stateGlobal, options) =>
        this.handleRoundCompletion(currRound, stateRound, stateGlobal, options),
      client: this.client,
      runResponseCycle,
      executionId: this.executionId,
      checkInterruption: () => this.checkInterruption(),
      setAbortController: (ctrl) => {
        this.abortController = ctrl;
      },
    });
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
      let messages: ProviderMessage[] = [];
      let continueRounds = true;

      const totalRounds = this.getNumberOfRounds();
      for (let currRound = 0; currRound < totalRounds; currRound++) {
        if (
          currRound > 0 &&
          (!this.agentConfig.toolConfig.reflect ||
            !continueRounds ||
            this.isInterrupted)
        ) {
          break;
        }

        this.logger.debug(`Processing round ${currRound}`);
        this.userVars.CURRENT_ROUND = currRound;
        const toolState = new ToolState();
        const node = this.createRoundNode();

        const [stateRound, updatedGlobal, newMessages, endTurn, usedToolState] =
          await this.withRoundGroup(`r${currRound}`, async (roundGroupId) =>
            node.run({
              currRound,
              stateGlobal,
              messages,
              toolState,
              roundGroupId,
              outputPath: this.outputFile[currRound],
            }),
          );

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
}
