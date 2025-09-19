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
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
import { ToolState } from '@agent/core/ToolState';
import { BaseAgent } from '@agent/implementations/BaseAgent';
import type { IModelHandler } from '@agent/modelHandlers';
import { OutputHandler, IOutputHandler } from '@agent/output';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { PromptBuilder } from '@agent/utils/PromptBuilder';
import { writePromptToXml } from '@agent/utils/promptUtils';
import { Node } from '@agent/node';

// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - latex utils
import { LatexMediaManager } from '@latex';

// System imports - common utilities
import { getConfig } from '@utils/config';

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

export interface RoundLifecycleResult {
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  messages: any[];
  endTurn: boolean;
  toolState: ToolState;
}

export interface RoundLifecycleSharedContext {
  currRound: number;
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  messages: any[];
  prefill: string;
  outputPath: string;
  roundGroupId: string;
  result?: RoundLifecycleResult;
}

interface RoundLifecyclePrepResult {
  endTurn: boolean;
  messages: any[];
}

interface RoundLifecycleExecResult extends RoundLifecycleResult {
  didExecuteCycle: boolean;
}

export interface ReflectionRoundNodeDeps<C> {
  agentConfig: AgentConfig;
  agentSetting: AgentSetting;
  agentPrompt: AgentPrompt;
  modelHandler: IModelHandler<any, any, any, any, C>;
  logger: AgentLogger;
  userVars: Record<string, any>;
  getClient: () => C;
  checkInterruption: () => Promise<boolean> | boolean;
  setAbortController: (ctrl: AbortController | null) => void;
  runResponseCycle: (
    options: ResponseCycleOptions<C>,
    messages: any[],
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    toolState: ToolState,
    outputPath: string,
    roundGroupId?: string,
    executionId?: ExecutionId,
  ) => Promise<[AgentStateRound, AgentStateGlobal, ToolState, boolean]>;
  handleRoundCompletion: (
    currRound: number,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    options: RoundOutputOptions,
  ) => Promise<void>;
  executionId?: ExecutionId;
}

export class ReflectionRoundNode<C> extends Node<RoundLifecycleSharedContext> {
  private currentShared?: RoundLifecycleSharedContext;

  constructor(private readonly deps: ReflectionRoundNodeDeps<C>) {
    super();
  }

  async prep(
    shared: RoundLifecycleSharedContext,
  ): Promise<RoundLifecyclePrepResult> {
    this.currentShared = shared;
    const [endTurn, updatedMessages] =
      await this.deps.modelHandler.initializeOutputAndPrefill(
        this.deps.agentConfig,
        this.deps.agentSetting,
        shared.messages,
        shared.toolState,
        shared.outputPath,
        shared.prefill,
        shared.roundGroupId,
      );
    shared.messages = updatedMessages;
    return { endTurn, messages: updatedMessages };
  }

  async exec(
    prepRes: RoundLifecyclePrepResult,
  ): Promise<RoundLifecycleExecResult> {
    const shared = this.currentShared;
    if (!shared) {
      throw new Error('Round lifecycle executed without a shared context.');
    }

    if (prepRes.endTurn) {
      return {
        stateRound: shared.stateRound,
        stateGlobal: shared.stateGlobal,
        messages: prepRes.messages,
        endTurn: true,
        toolState: shared.toolState,
        didExecuteCycle: false,
      };
    }

    const client = this.deps.getClient();
    const options: ResponseCycleOptions<C> = {
      modelHandler: this.deps.modelHandler,
      agentSetting: this.deps.agentSetting,
      agentConfig: this.deps.agentConfig,
      agentPrompt: this.deps.agentPrompt,
      userVars: this.deps.userVars,
      logger: this.deps.logger,
      client,
      checkInterruption: this.deps.checkInterruption,
      setAbortController: this.deps.setAbortController,
    };

    const [
      updatedStateRound,
      updatedStateGlobal,
      updatedToolState,
      newEndTurn,
    ] = await this.deps.runResponseCycle(
      options,
      prepRes.messages,
      shared.stateRound,
      shared.stateGlobal,
      shared.toolState,
      shared.outputPath,
      shared.roundGroupId,
      this.deps.executionId,
    );

    return {
      stateRound: updatedStateRound,
      stateGlobal: updatedStateGlobal,
      messages: prepRes.messages,
      endTurn: newEndTurn,
      toolState: updatedToolState,
      didExecuteCycle: true,
    };
  }

  async post(
    shared: RoundLifecycleSharedContext,
    _prepRes: RoundLifecyclePrepResult,
    execRes: RoundLifecycleExecResult,
  ): Promise<string | undefined> {
    await this.deps.handleRoundCompletion(
      shared.currRound,
      execRes.stateRound,
      execRes.stateGlobal,
      {
        outputFile: shared.outputPath,
        endTurn: execRes.endTurn,
        processGroupId: shared.roundGroupId,
      },
    );

    if (shared.currRound === 0 && execRes.didExecuteCycle) {
      this.deps.logger.debug(
        `stateGlobal: ${JSON.stringify(execRes.stateGlobal)}`,
        shared.roundGroupId,
      );
    }

    shared.stateRound = execRes.stateRound;
    shared.stateGlobal = execRes.stateGlobal;
    shared.toolState = execRes.toolState;
    shared.messages = execRes.messages;
    shared.result = {
      stateRound: execRes.stateRound,
      stateGlobal: execRes.stateGlobal,
      messages: execRes.messages,
      endTurn: execRes.endTurn,
      toolState: execRes.toolState,
    };

    this.currentShared = undefined;
    return 'default';
  }
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

  protected createRoundNode(): ReflectionRoundNode<C> {
    return new ReflectionRoundNode<C>({
      agentConfig: this.agentConfig,
      agentSetting: this.agentSetting,
      agentPrompt: this.agentPrompt,
      modelHandler: this.modelHandler,
      logger: this.logger,
      userVars: this.userVars,
      getClient: () => this.getClientInstance(),
      checkInterruption: () => this.checkInterruption(),
      setAbortController: (ctrl) => {
        this.abortController = ctrl;
      },
      runResponseCycle,
      handleRoundCompletion: (currRound, stateRound, stateGlobal, options) =>
        this.handleRoundCompletion(currRound, stateRound, stateGlobal, options),
      executionId: this.executionId,
    });
  }

  private async runRoundWithNode(
    shared: RoundLifecycleSharedContext,
  ): Promise<RoundLifecycleResult> {
    const node = this.createRoundNode();
    await node.run(shared);

    if (!shared.result) {
      throw new Error('Round execution did not produce a result.');
    }

    return shared.result;
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
      const prefill = await promptBuilder.buildPrefill(currRound);
      toolState.updateAccumulatedOutput(prefill);

      const stateRound = new AgentStateRound(currRound);
      const shared: RoundLifecycleSharedContext = {
        currRound,
        stateRound,
        stateGlobal,
        toolState,
        messages,
        prefill,
        outputPath: this.outputFile[currRound],
        roundGroupId,
      };

      const result = await this.runRoundWithNode(shared);
      return [
        result.stateRound,
        result.stateGlobal,
        result.messages,
        result.endTurn,
        result.toolState,
      ];
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
        const outputFiles = this.outputHandler.outputFiles[currRound - 1];
        if (outputFiles && outputFiles.length > 0) {
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

      const shared: RoundLifecycleSharedContext = {
        currRound,
        stateRound,
        stateGlobal,
        toolState,
        messages: roundMessages,
        prefill,
        outputPath: this.outputFile[currRound],
        roundGroupId,
      };

      const result = await this.runRoundWithNode(shared);
      return [
        result.stateRound,
        result.stateGlobal,
        result.messages,
        result.endTurn,
        result.toolState,
      ];
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
