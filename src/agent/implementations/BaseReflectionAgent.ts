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
import {
  createReflectionRunFlow,
  type ReflectionRunHooks,
  type ReflectionRunLifecycle,
  type ReflectionRunShared,
  type ReflectionRunState,
} from '@agent/implementations/flows/ReflectionRunFlow';
import { runAgentFlow } from '@agent/implementations/flows/common/AgentRunFlowRunner';
import type { AgentRunHooks } from '@agent/implementations/flows/common/types';
import {
  createReflectionRoundFlow,
  type ReflectionRoundShared,
} from '@agent/implementations/flows/ReflectionRoundFlow';
import type { IModelHandler } from '@agent/modelHandlers';
import { OutputHandler, NamedOutputFile, IOutputHandler } from '@agent/output';
import type { AgentRunContext } from '@agent/runtime/AgentRunContext';
import { PromptBuilder } from '@agent/utils/PromptBuilder';
import { writePromptToXml } from '@agent/utils/promptUtils';
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

export interface ReflectionRoundContext {
  roundIndex: number;
  globalState: AgentStateGlobal;
  messages: any[];
}

export interface ReflectionRoundResult {
  roundState: AgentStateRound;
  globalState: AgentStateGlobal;
  messages: any[];
  shouldContinue: boolean;
  toolState: ToolState;
}

interface RoundPipelineContext {
  roundIndex: number;
  roundState: AgentStateRound;
  globalState: AgentStateGlobal;
  toolState: ToolState;
  preparedMessages: any[];
  prefill: string;
  outputPath: string;
  roundGroupId: string;
}

/**
 * Abstract base class for agents that support multi-turn reflection.
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
  protected outputHandler!: IOutputHandler;
  protected latexMediaManager!: LatexMediaManager;
  protected promptBuilder?: PromptBuilder;
  public roundStates: AgentStateRound[] = [];
  public toolStates: ToolState[] = [];

  constructor(
    modelHandler: IModelHandler<any, any, any, any, C>,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
  ) {
    const workflowSetting = requireWorkflowSetting(agentSetting);
    super(
      modelHandler,
      agentConfig,
      workflowSetting,
      agentPrompt,
      agentPath,
    );
    this.agentSetting = workflowSetting;

    // Initialize basic attributes
    const numRounds = this.getTotalRounds();
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

  }

  public override applyRunContext(context: AgentRunContext): void {
    super.applyRunContext(context);
    this.outputHandler = new OutputHandler(
      this.agentSetting,
      this.agentConfig,
      this.logId,
      this.baseFiles,
      context,
    );
    this.latexMediaManager = new LatexMediaManager(context.logger);
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

  protected resetPromptBuilder(): void {
    this.promptBuilder = undefined;
  }

  public setCurrentRound(roundIndex: number): void {
    this.userVars.CURRENT_ROUND = roundIndex;
  }

  /**
   * Calculates the total number of rounds to execute.
   * Returns the maximum of configured rounds and userRequest array length.
   * Subclasses may override to simplify workflows (e.g., DirectAgent).
   */
  protected getTotalRounds(): number {
    const requestArray = Array.isArray(this.agentPrompt.userRequest)
      ? this.agentPrompt.userRequest
      : this.agentPrompt.userRequest
        ? [this.agentPrompt.userRequest]
        : [];
    return Math.max(this.agentSetting.rounds ?? 2, requestArray.length);
  }

  /**
   * Generates output file path for specified conversation round.
   */
  protected abstract getOutputFile(currRound: number): string;

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
   * 2. LaTeX diff operations via diffManager.handleLatexdiffofOutput (only when endTurn is true)
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
        const mapping = this.outputHandler.getRoundMapping(currRound);
        await this.outputHandler.diffManager.handleLatexdiffofOutput(
          currRound,
          mapping,
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
  private async runRoundPipeline({
    roundIndex,
    roundState,
    globalState,
    toolState,
    preparedMessages,
    prefill,
    outputPath,
    roundGroupId,
  }: RoundPipelineContext): Promise<ReflectionRoundResult> {
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
      const cycleResult = await runResponseCycle({
        options: this.createResponseCycleOptions(),
        messages: updatedMessages,
        stateRound: roundState,
        stateGlobal: globalState,
        toolState,
        outputFile: outputPath,
      });

      await this.handleRoundCompletion(
        roundIndex,
        cycleResult.stateRound,
        cycleResult.stateGlobal,
        {
          outputFile: outputPath,
          endTurn: cycleResult.endTurn,
          processGroupId: roundGroupId,
        },
      );

      if (roundIndex === 0) {
        this.logger.debug(
          `stateGlobal: ${JSON.stringify(cycleResult.stateGlobal)}`,
          roundGroupId,
        );
      }

      return {
        roundState: cycleResult.stateRound,
        globalState: cycleResult.stateGlobal,
        messages: updatedMessages,
        shouldContinue: cycleResult.endTurn,
        toolState: cycleResult.toolState,
      };
    }

    await this.handleRoundCompletion(roundIndex, roundState, globalState, {
      outputFile: outputPath,
      endTurn,
      processGroupId: roundGroupId,
    });

    return {
      roundState,
      globalState,
      messages: updatedMessages,
      shouldContinue: endTurn,
      toolState,
    };
  }

  private createResponseCycleOptions(): ResponseCycleOptions<C> {
    const client = this.getClientInstance();
    const baseOptions = this.buildCycleBaseOptions({
      agentSetting: this.agentSetting,
      agentPrompt: this.agentPrompt,
      client,
    });

    return {
      ...baseOptions,
      agentConfig: this.agentConfig,
    };
  }

  private async prepareRoundContext(
    currRound: number,
    _stateGlobal: AgentStateGlobal,
    messages: any[],
    toolState: ToolState,
    roundGroupId: string,
  ): Promise<{
    stateRound: AgentStateRound;
    preparedMessages: any[];
    prefill?: string;
    skip: boolean;
  }> {
    const stateRound = new AgentStateRound(currRound);
    const promptBuilder = this.getPromptBuilder();

    if (currRound === 0) {
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();

      let prefixWithStats = userPrefix;
      if (toolState.texcountStats) {
        prefixWithStats = `${toolState.texcountStats}${userPrefix}`;
      }

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
          this.getExecutionId(),
        );
        this.logger.info(
          `Saved input prompt to ${promptPath}`,
          roundGroupId,
          MESSAGE_TYPES.DEFAULT,
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

      return {
        stateRound,
        preparedMessages: initialMessages,
        prefill,
        skip: false,
      };
    }

    const userRequest = await promptBuilder.buildUserRequest(currRound);
    let userMessage = userRequest ? `${userRequest}\n` : '';
    if (toolState.texcountStats) {
      userMessage = `${toolState.texcountStats}${userMessage}`;
    }

    if (!userMessage.trim()) {
      return {
        stateRound,
        preparedMessages: messages,
        skip: true,
      };
    }

    const roundMessages = await this.modelHandler.createRoundMessages(
      messages,
      userMessage,
      toolState.mediaFiles,
    );

    const prefill = await promptBuilder.buildPrefill(currRound);
    toolState.updateAccumulatedOutput(prefill);

    return {
      stateRound,
      preparedMessages: roundMessages,
      prefill,
      skip: false,
    };
  }

  private async prepareToolState(
    currRound: number,
    toolState: ToolState,
    roundGroupId: string,
  ): Promise<void> {
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
      return;
    }

    let outputFiles: string[] = [];
    if (this.agentConfig.outputFiles) {
      outputFiles = [...this.agentConfig.outputFiles];
    } else {
      const previousRoundFiles = this.outputHandler.ensureRound(currRound - 1);
      if (previousRoundFiles.length > 0) {
        outputFiles = [previousRoundFiles[0]];
      }
    }

    if (outputFiles.length === 0) {
      return;
    }

    await this.latexMediaManager.processOutputFiles(
      outputFiles,
      toolState,
      this.agentConfig.toolConfig,
      this.modelHandler.capabilities.supportsVision,
      roundGroupId,
    );
  }

  public async runReflectionRound({
    roundIndex,
    globalState,
    messages,
  }: ReflectionRoundContext): Promise<ReflectionRoundResult> {
    this.logger.debug(`Processing round ${roundIndex}`);
    const toolState = new ToolState();

    return this.withRoundGroup(`r${roundIndex}`, async (roundGroupId) => {
      const shared: ReflectionRoundShared = {
        runtime: {
          toolState,
        },
        hooks: {
          prepareToolState: () =>
            this.prepareToolState(roundIndex, toolState, roundGroupId),
          prepareRoundContext: () =>
            this.prepareRoundContext(
              roundIndex,
              globalState,
              messages,
              toolState,
              roundGroupId,
            ),
          runRoundPipeline: ({ stateRound, preparedMessages, prefill }) =>
            this.runRoundPipeline({
              roundIndex,
              roundState: stateRound,
              globalState,
              toolState,
              preparedMessages,
              prefill,
              outputPath: this.outputFile[roundIndex],
              roundGroupId,
            }),
          createSkipResult: (stateRound) => ({
            roundState: stateRound,
            globalState,
            messages,
            shouldContinue: true,
            toolState,
          }),
        },
      };

      const flow = createReflectionRoundFlow();
      await flow.run(shared);

      if (!shared.runtime.result) {
        throw new Error('Reflection round did not produce a result.');
      }

      return shared.runtime.result;
    });
  }

  /**
   * Main execution method that processes inputs and generates outputs.
   */
  public async run(): Promise<void> {
    const lifecycle: ReflectionRunLifecycle = {
      phase: 'idle',
      status: 'pending',
      error: undefined,
    };

    const totalRounds = this.getTotalRounds();

    await runAgentFlow<ReflectionRunShared<C>>({
      agent: this,
      lifecycle,
      createState: () =>
        ({
          totalRounds,
          currentRound: 0,
          continueRounds: true,
          messages: [],
          globalState: new AgentStateGlobal(),
        }) satisfies ReflectionRunState,
      createFlow: () => createReflectionRunFlow<C>(),
      extendHooks: (baseHooks: AgentRunHooks) => {
        const baseStart = baseHooks.start;
        return {
          ...baseHooks,
          init: async (runGroupId) => {
            await this.init(runGroupId, { createGroup: true });
          },
          start: async () => {
            const runGroupId = await baseStart();
            if (!runGroupId) {
              throw new Error(
                'Run group identifier is required for reflection runs.',
              );
            }
            return runGroupId;
          },
          resetPromptBuilder: () => this.resetPromptBuilder(),
        } satisfies ReflectionRunHooks;
      },
    });
  }
}
