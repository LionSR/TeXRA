// Local imports - agent

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, AgentPrompt } from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import { BaseAgent } from '@agent/implementations/BaseAgent';
import type { IModelHandler } from '@agent/modelHandlers';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { OutputHandler, IOutputHandler } from '@agent/output';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { PromptBuilder } from '@agent/utils/PromptBuilder';
import { writePromptToXml } from '@agent/utils/promptUtils';
// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - log

// Local imports - latex utils
import { LatexMediaManager } from '@latex';

// Local imports - nodes
import {
  ReflectionRoundNode,
  type ReflectionRoundResult,
  type ReflectionRoundShared,
} from './reflection/nodes/ReflectionRoundNode';
import type { RoundOutputOptions } from './reflection/types';
export type { RoundOutputOptions } from './reflection/types';

// System imports - common utilities

// Local imports - utilities
import { calculateTotalRounds } from '@agent/utils/roundUtils';
import { WorkspaceFS } from '@utils/files';

/**
 * Abstract base class for agents that support multi-turn reflection and refinement.
 * Provides core functionality for processing inputs, managing state, and handling outputs
 * across multiple conversation rounds.
 */

type RoundFactoryInput = {
  currRound: number;
  stateGlobal: AgentStateGlobal;
  messages: ProviderMessage[];
  toolState: ToolState;
  roundGroupId: string;
};

type RoundFactoryResult =
  | { kind: 'skip'; result: ReflectionRoundResult }
  | { kind: 'node'; node: ReflectionRoundNode; shared: ReflectionRoundShared };

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

  private buildRoundNode(): ReflectionRoundNode {
    return new ReflectionRoundNode({
      modelHandler: this.modelHandler,
      agentConfig: this.agentConfig,
      agentSetting: this.agentSetting,
      agentPrompt: this.agentPrompt,
      userVars: this.userVars,
      logger: this.logger,
      client: this.client,
      executionId: this.executionId,
      checkInterruption: () => this.checkInterruption(),
      setAbortController: (ctrl) => {
        this.abortController = ctrl;
      },
      handleRoundCompletion: (
        currRound,
        stateRound,
        stateGlobal,
        completionOptions,
      ) =>
        this.handleRoundCompletion(
          currRound,
          stateRound,
          stateGlobal,
          completionOptions,
        ),
    });
  }

  private async createRoundExecution(
    input: RoundFactoryInput,
  ): Promise<RoundFactoryResult> {
    const { currRound, stateGlobal, messages, toolState, roundGroupId } = input;
    const outputPath = this.outputFile[currRound];
    const stateRound = new AgentStateRound(currRound);

    this.logger.debug(`Processing round ${currRound}`);

    if (currRound === 0) {
      const inputFiles = [
        this.agentConfig.inputFile,
        ...(this.agentConfig.inputFiles || []),
      ];
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

      const promptBuilder = this.getPromptBuilder();
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();

      let prefixWithStats = userPrefix;
      if (toolState.texcountStats) {
        prefixWithStats = `${toolState.texcountStats}${userPrefix}`;
      }

      if (this.agentConfig.toolConfig.printInputPrompt) {
        await writePromptToXml(
          systemPrompt,
          prefixWithStats,
          userRequest,
          this.agentConfig.inputFile,
          this.agentConfig.agent,
        );
      }

      const initialMessages = await this.modelHandler.initializeMessages(
        prefixWithStats,
        userRequest,
        toolState.mediaFiles,
        systemPrompt,
      );

      const prefill = await promptBuilder.buildPrefill(currRound);
      toolState.updateAccumulatedOutput(prefill);

      const shared: ReflectionRoundShared = {
        currRound,
        stateRound,
        stateGlobal: new AgentStateGlobal(),
        toolState,
        messages: initialMessages,
        prefill,
        outputPath,
        roundGroupId,
      };

      return { kind: 'node', node: this.buildRoundNode(), shared };
    }

    if (this.agentConfig.outputFiles) {
      await this._handleToolStateForOutput(
        this.agentConfig.outputFiles,
        currRound,
        toolState,
        roundGroupId,
      );
    } else {
      const outputFiles = this.outputHandler.outputFiles[currRound - 1];
      if (outputFiles && outputFiles.length > 0) {
        await this._handleToolStateForOutput(
          [outputFiles[0]],
          currRound,
          toolState,
          roundGroupId,
        );
      }
    }

    const promptBuilder = this.getPromptBuilder();
    const userRequestReflect =
      await promptBuilder.buildReflectPrompt(currRound);
    let userMessage = userRequestReflect ? `${userRequestReflect}\n` : '';
    if (toolState.texcountStats) {
      userMessage = `${toolState.texcountStats}${userMessage}`;
    }

    if (!userMessage.trim()) {
      return {
        kind: 'skip',
        result: {
          stateRound,
          stateGlobal,
          messages,
          endTurn: true,
          toolState,
        },
      };
    }

    const roundMessages = await this.modelHandler.createRoundMessages(
      messages,
      userMessage,
      toolState.mediaFiles,
    );

    const prefill = await promptBuilder.buildPrefill(currRound);
    toolState.updateAccumulatedOutput(prefill);

    const shared: ReflectionRoundShared = {
      currRound,
      stateRound,
      stateGlobal,
      toolState,
      messages: roundMessages,
      prefill,
      outputPath,
      roundGroupId,
    };

    return { kind: 'node', node: this.buildRoundNode(), shared };
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

        this.userVars.CURRENT_ROUND = currRound;
        const toolState = new ToolState();

        const roundResult = await this.withRoundGroup(
          `r${currRound}`,
          async (roundGroupId) => {
            const setup = await this.createRoundExecution({
              currRound,
              stateGlobal,
              messages,
              toolState,
              roundGroupId,
            });

            if (setup.kind === 'skip') {
              return setup.result;
            }

            return setup.node.run(setup.shared);
          },
        );

        this.roundStates.push(roundResult.stateRound);
        this.toolStates.push(roundResult.toolState);
        stateGlobal = roundResult.stateGlobal;
        messages = roundResult.messages;
        continueRounds = roundResult.endTurn;
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
    groupId?: string,
  ): Promise<void> {
    await this.latexMediaManager.processOutputFiles(
      outputFiles,
      toolState,
      this.agentConfig.toolConfig,
      this.modelHandler.capabilities.supportsVision,
      groupId ?? this.logger.getActiveGroupId(),
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
