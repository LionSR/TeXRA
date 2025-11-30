// Local imports - agent components
import type { IModelHandler } from '@agent/modelHandlers';
// Internal imports
import {
  OutputHandler,
  IOutputHandler,
  getOutputFileName,
  type RoundOutput,
  type OutputFileInfo,
} from '@agent/output';

// Type imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
import type { AgentRunHooks } from '@agent/implementations/flows/common/types';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Internal imports
import {
  AgentSetting,
  AgentPrompt,
  AgentWorkflowSetting,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import { createSharedStore } from '@agent/core/AgentSharedStore';
import { runResponseCycle } from '@agent/core/ResponseCycle';

// Internal imports
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { BaseAgent } from '@agent/implementations/BaseAgent';
import {
  createReflectionRunFlow,
  type ReflectionRunHooks,
  type ReflectionRunShared,
  type ReflectionRunState,
  type ReflectionRunPhase,
} from '@agent/implementations/flows/ReflectionRunFlow';

// Internal imports
import { createLifecycleState } from '@agent/implementations/flows/common/lifecycle';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { PromptBuilder } from '@agent/utils/PromptBuilder';
import { writePromptToXml } from '@agent/utils/promptUtils';
import type { AgentLogStage } from '@logger/AgentLogger';

// Local imports - configuration
import { getConfig } from '@utils/config';
import {
  WorkspaceFS,
  TaskRunFileService,
  createWorkspaceLocation,
  flexibleFS,
  type FileLocation,
  type AgentFileLocation,
} from '@utils/files';
import { LatexMediaManager } from '@latex';

/**
 * Options for handling round output.
 *
 * @property outputFile - The path to the file where the round's output will be saved.
 * @property endTurn - A flag indicating whether the current turn should be ended after processing.
 */
export interface RoundOutputOptions {
  outputFile: FileLocation;
  endTurn: boolean;
  stage?: AgentLogStage;
}

export interface ReflectionRoundResult {
  roundState: ConversationRoundState;
  runState: AgentRunState;
  messages: any[];
  shouldContinue: boolean;
  workspaceState: AgentWorkspaceState;
  output: RoundOutput | null;
}

export interface AgentRuntimeXmlExports {
  tagContents: Record<string, string | string[]>;
  documents: string[];
  singleOutputFile: string | null;
}

/**
 * Abstract base class for agents that support multi-turn reflection.
 * Provides core functionality for processing inputs, managing state, and handling outputs
 * across multiple conversation rounds.
 */
export abstract class BaseReflectionAgent<C = unknown> extends BaseAgent<C> {
  private static readonly ERR_ROUND_NOT_INITIALIZED =
    'Round context not initialized. Call beginRound() first.';
  /** File paths for each round's raw model output - always workspace or runStorage */
  protected outputFile: AgentFileLocation[];
  /** Multi-file output locations per round - always workspace or runStorage */
  protected outputFiles: { [key: number]: AgentFileLocation[] };
  /** Base input files - always workspace or runStorage */
  protected baseFiles: AgentFileLocation[];
  protected override agentSetting: AgentWorkflowSetting;
  protected useScratchpad: boolean = false;
  protected logId: number = 0;
  /** Handler for output file processing and validation. */
  protected outputHandler: IOutputHandler;
  protected latexMediaManager: LatexMediaManager;
  protected promptBuilder?: PromptBuilder;
  public roundStates: ConversationRoundState[] = [];
  public workspaceStates: AgentWorkspaceState[] = [];
  public roundOutputs: RoundOutput[] = [];
  public runtimeXmlExports: AgentRuntimeXmlExports = {
    tagContents: {},
    documents: [],
    singleOutputFile: null,
  };
  protected readonly fileService: TaskRunFileService;
  private hydrationPromise: Promise<void> | null = null;
  private hydratedRoundCount = 0;

  // Current round execution context - set when round begins
  private isRoundActive = false;
  private currentRoundIndex: number = 0;
  private currentMessages: any[] = [];
  private currentRunState: AgentRunState | null = null;
  private currentWorkspaceState: AgentWorkspaceState | null = null;

  constructor(
    modelHandler: IModelHandler<any, any, any, any, C>,
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    agentPrompt: AgentPrompt,
    agentPath: string,
    context: AgentExecutionContext,
  ) {
    const workflowSetting = requireWorkflowSetting(agentSetting);
    super(
      modelHandler,
      agentConfig,
      workflowSetting,
      agentPrompt,
      agentPath,
      context,
    );
    this.agentSetting = workflowSetting;

    // Initialize basic attributes
    const numRounds = this.getTotalRounds();
    // Initialize fileService first so we can use it below
    this.fileService = new TaskRunFileService(context.executionId);

    this.outputFile = new Array<AgentFileLocation>(numRounds);
    this.outputFiles = {};
    for (let i = 0; i < numRounds; i++) {
      this.outputFiles[i] = [];
    }
    // Base files are ALWAYS workspace locations (inputs from workspace)
    // Even in run-storage mode, we snapshot FROM workspace TO run storage
    this.baseFiles =
      this.agentConfig.outputFiles.length > 0
        ? this.agentConfig.outputFiles.map((f) =>
            createWorkspaceLocation(WorkspaceFS.fullPath(f), f),
          )
        : [
            createWorkspaceLocation(
              WorkspaceFS.fullPath(this.agentConfig.inputFile),
              this.agentConfig.inputFile,
            ),
          ];

    // Check scratchpad usage
    // this is not so neat
    this.useScratchpad =
      this.agentSetting.prefills?.includes('<scratchpad>') || false;

    // Set output files for all rounds
    for (let i = 0; i < numRounds; i++) {
      this.outputFile[i] = this.getOutputFileLocation(i);
    }

    // Initialize logging
    this.logId = 0;

    this.outputHandler = new OutputHandler(
      this.agentSetting,
      this.agentConfig,
      this.logId,
      this.baseFiles,
      this.logger,
      this.fileService,
      this.executionId,
    );

    this.latexMediaManager = new LatexMediaManager(
      this.logger,
      this.fileService,
    );
  }

  public async hydrateOutputState(params: {
    executionId: ExecutionId;
    runId?: string | null;
    rounds: Map<number, OutputFileInfo[]>;
  }): Promise<void> {
    const hydration = (async () => {
      this.roundOutputs = [];
      this.fileService.updateRunContext(params.executionId);
      this.outputHandler.hydrateFromArtifacts(
        params.runId ?? null,
        params.rounds,
      );

      const sortedRounds = Array.from(params.rounds.keys()).sort(
        (a, b) => a - b,
      );

      let hydratedCount = 0;

      try {
        for (const round of sortedRounds) {
          const output = await this.outputHandler.getRoundArtifacts(round);
          this.roundOutputs[round] = output;
        }

        hydratedCount = sortedRounds.length;
      } finally {
        this.hydratedRoundCount = hydratedCount;
      }
    })();

    this.hydrationPromise = hydration;

    try {
      await hydration;
    } finally {
      if (this.hydrationPromise === hydration) {
        this.hydrationPromise = null;
      }
    }
  }

  private async awaitPendingHydration(): Promise<void> {
    const pending = this.hydrationPromise;
    if (!pending) {
      return;
    }

    try {
      await pending;
    } finally {
      if (this.hydrationPromise === pending) {
        this.hydrationPromise = null;
      }
    }
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

  public resetPromptBuilder(): void {
    this.promptBuilder = undefined;
  }

  /**
   * Initialize the agent's round execution context.
   * Call this before executing a round to set up the execution environment.
   *
   * **Threading Model**: This class assumes single-threaded execution. The `isRoundActive`
   * flag provides a guard against programming errors but is not designed for concurrent access.
   * The check-then-set pattern (lines 290-296) is not atomic and would fail under true concurrent
   * execution. In the current architecture, all agent execution happens sequentially on the
   * main event loop, making this safe.
   *
   * **Workspace State**: Creates a fresh `AgentWorkspaceState` for each round. This is intentional -
   * workspace state is round-specific and gets populated during round execution (input files,
   * prompt files, etc.). Historical workspace states are preserved in `this.workspaceStates[]`
   * by `recordRoundResult()`.
   *
   * @param roundIndex - Zero-based round index
   * @param runState - Current run state (carries accumulated state across rounds)
   * @param messages - Conversation messages for this round
   * @throws {Error} If another round is already active
   */
  public beginRound(
    roundIndex: number,
    runState: AgentRunState,
    messages: any[],
  ): void {
    if (this.isRoundActive) {
      throw new Error(
        'Cannot begin new round while another is active. Call recordRoundResult() to complete the current round.',
      );
    }

    this.isRoundActive = true;
    this.currentRoundIndex = roundIndex;
    this.currentMessages = messages;
    this.currentRunState = runState;
    // Fresh workspace state per round - populated during execution
    this.currentWorkspaceState = new AgentWorkspaceState();
    this.resetTransientUserVars({ CURRENT_ROUND: roundIndex });
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
   * Default implementation uses scratchpad mode detection to determine file extension.
   * Override for specialized naming logic (e.g., MergeAgent).
   * @returns AgentFileLocation - always workspace or runStorage (never external)
   */
  public getOutputFileLocation(currRound: number): AgentFileLocation {
    const baseOutputFile = this.agentConfig.inputFile;
    const fileExtension = this.useScratchpad
      ? 'xml'
      : this.agentSetting.outputExt;

    const fileName = getOutputFileName(
      baseOutputFile,
      this.agentConfig.agent,
      this.modelHandler.config.name,
      fileExtension,
      currRound,
      this.agentConfig.editedFile || undefined,
    );

    // fileService.createLocation always returns workspace or runStorage for agent outputs
    return this.fileService.createLocation(fileName) as AgentFileLocation;
  }

  /**
   * Processes completion of conversation round.
   */
  private async handleRoundCompletion(
    currRound: number,
    stateRound: ConversationRoundState,
    runState: AgentRunState,
    options: RoundOutputOptions,
  ): Promise<RoundOutput> {
    const { outputFile, endTurn, stage } = options;

    const execute = async (scope: AgentLogStage | undefined) => {
      await this.handleOutput(currRound, stateRound, runState, {
        ...options,
        stage: scope,
      });

      this.logger.debug(`Completed round ${currRound}`);

      await this.outputHandler.finalizeRound(outputFile, currRound, {
        endTurn,
        stage: scope,
      });

      const output = await this.outputHandler.getRoundArtifacts(currRound);
      this.roundOutputs[currRound] = output;
      return output;
    };

    if (stage) {
      return stage.within(() => execute(stage));
    }

    return execute(undefined);
  }

  /**
   * Processes output files for current round.
   * This method orchestrates the overall output processing flow with clear separation of concerns:
   * - LaTeX diff operations via diffManager.handleLatexdiffofOutput (only when endTurn is true)
   *
   * The actual file processing is handled separately in processOutputFiles.
   *
   * @returns Array of processed output file paths
   */
  protected async handleOutput(
    currRound: number,
    _stateRound: ConversationRoundState,
    _runState: AgentRunState,
    options: RoundOutputOptions,
  ): Promise<OutputFileInfo[]> {
    const { endTurn, stage } = options;
    // If this is the end of a turn, handle latexdiff operations as a separate step
    if (endTurn && this.outputHandler.hasRoundOutputs(currRound)) {
      const existingBase = await Promise.all(
        this.baseFiles.map(async (f) => await flexibleFS.exists(f)),
      );

      if (existingBase.some((e) => e)) {
        // Pass the process group ID to maintain proper nesting in the log hierarchy
        const mapping = this.outputHandler.getRoundMapping(currRound);
        await this.outputHandler.diffManager.handleLatexdiffofOutput(
          currRound,
          mapping,
          stage,
        );
      } else {
        this.logger.debug(
          `Skipping latexdiff for round ${currRound} - base files missing`,
        );
      }
    }

    return this.outputHandler.ensureRound(currRound);
  }

  /**
   * Executes the round pipeline using the current round context.
   * Must be called after beginRound() to ensure context is initialized.
   *
   * @param roundState - Round state prepared for execution
   * @param preparedMessages - Messages prepared for the model
   * @param prefill - Initial text for the model response buffer
   * @returns Updated round/global state, messages, completion flag, and tool state after execution.
   */
  public async runRoundPipeline(
    roundState: ConversationRoundState,
    preparedMessages: any[],
    prefill: string,
  ): Promise<ReflectionRoundResult> {
    if (!this.currentRunState || !this.currentWorkspaceState) {
      throw new Error(BaseReflectionAgent.ERR_ROUND_NOT_INITIALIZED);
    }

    const roundIndex = this.currentRoundIndex;
    const runState = this.currentRunState;
    const workspaceState = this.currentWorkspaceState;
    const outputLocation = this.outputFile[roundIndex];
    const [endTurn, updatedMessages] =
      await this.modelHandler.initializeOutputAndPrefill(
        this.agentConfig,
        this.agentSetting,
        preparedMessages,
        workspaceState,
        outputLocation,
        prefill,
      );

    const store = createSharedStore({
      roundIndex: roundState.roundIndex,
      roundState,
      runState,
      workspaceState: workspaceState,
      userChannels: this.userVarChannels,
      onRoundFinalized: this.getUsageRecorder('workflow'),
    });

    if (!endTurn) {
      const cycleResult = await runResponseCycle({
        options: this.createResponseCycleOptions(),
        messages: updatedMessages,
        outputLocation: outputLocation,
        store,
      });

      // If the response cycle failed with an error, throw to stop round progression
      if (cycleResult.failedWithError) {
        throw new Error(
          cycleResult.errorMessage ?? 'Response cycle failed with an error',
        );
      }

      // If the user cancelled, stop gracefully without throwing
      if (cycleResult.userCancelled) {
        return {
          roundState: store.round,
          runState: store.run,
          messages: updatedMessages,
          shouldContinue: false,
          workspaceState: store.workspace,
          output: null,
        };
      }

      const artifacts = await this.handleRoundCompletion(
        roundIndex,
        store.round,
        store.run,
        {
          outputFile: outputLocation,
          endTurn: cycleResult.endTurn,
        },
      );

      return {
        roundState: store.round,
        runState: store.run,
        messages: updatedMessages,
        shouldContinue: this.shouldRunAnotherRound(cycleResult.endTurn),
        workspaceState: store.workspace,
        output: artifacts,
      };
    }

    await store.finalizeRound();

    const artifacts = await this.handleRoundCompletion(
      roundIndex,
      store.round,
      store.run,
      {
        outputFile: outputLocation,
        endTurn,
      },
    );

    return {
      roundState: store.round,
      runState: store.run,
      messages: updatedMessages,
      shouldContinue: this.shouldRunAnotherRound(endTurn),
      workspaceState: store.workspace,
      output: artifacts,
    };
  }

  private shouldRunAnotherRound(endTurn: boolean): boolean {
    const nextRound = this.currentRoundIndex + 1;
    const hasRemainingRounds = nextRound < this.getTotalRounds();
    if (endTurn) {
      return true;
    }

    return hasRemainingRounds && !this.isInterruptionRequested();
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
      fileService: this.fileService,
    };
  }

  public async prepareRoundContext(): Promise<{
    stateRound: ConversationRoundState;
    preparedMessages: any[];
    prefill?: string;
    skip: boolean;
  }> {
    if (!this.currentWorkspaceState) {
      throw new Error(BaseReflectionAgent.ERR_ROUND_NOT_INITIALIZED);
    }

    const currRound = this.currentRoundIndex;
    const messages = this.currentMessages;
    const workspaceState = this.currentWorkspaceState;
    const stateRound = new ConversationRoundState(currRound);
    const promptBuilder = this.getPromptBuilder();

    if (currRound === 0) {
      const { systemPrompt, userRequest, userPrefix } =
        await promptBuilder.buildInitialPrompts();

      let prefixWithStats = userPrefix;
      if (workspaceState.document.texcountStats) {
        prefixWithStats = `${workspaceState.document.texcountStats}${userPrefix}`;
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
          this.executionId,
        );
        this.logger.info(`Saved input prompt to ${promptPath}`);
      }

      const initialMessages = await this.modelHandler.initializeMessages(
        prefixWithStats,
        userRequest,
        workspaceState.media.files,
        systemPrompt,
      );

      const prefill = await promptBuilder.buildPrefill(currRound);
      workspaceState.assembly.updateAccumulatedOutput(prefill);

      return {
        stateRound,
        preparedMessages: initialMessages,
        prefill,
        skip: false,
      };
    }

    const userRequest = await promptBuilder.buildUserRequest(currRound);
    let userMessage = userRequest ? `${userRequest}\n` : '';
    if (workspaceState.document.texcountStats) {
      userMessage = `${workspaceState.document.texcountStats}${userMessage}`;
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
      workspaceState.media.files,
    );

    const prefill = await promptBuilder.buildPrefill(currRound);
    workspaceState.assembly.updateAccumulatedOutput(prefill);

    return {
      stateRound,
      preparedMessages: roundMessages,
      prefill,
      skip: false,
    };
  }

  /**
   * Prepares the workspace state for the current round.
   * Uses the round context initialized by beginRound().
   */
  public async prepareWorkspaceState(): Promise<void> {
    if (!this.currentWorkspaceState) {
      throw new Error(BaseReflectionAgent.ERR_ROUND_NOT_INITIALIZED);
    }

    const currRound = this.currentRoundIndex;
    const workspaceState = this.currentWorkspaceState;
    if (currRound === 0) {
      const inputFiles = [
        this.fileService.createLocation(this.agentConfig.inputFile),
        ...this.agentConfig.inputFiles.map((f) =>
          this.fileService.createLocation(f),
        ),
      ];
      const extraMedia: string[] = [];

      if (this.modelHandler.capabilities.supportsVision) {
        if (
          this.agentConfig.mediaFile &&
          !workspaceState.media.files.includes(this.agentConfig.mediaFile)
        ) {
          extraMedia.push(this.agentConfig.mediaFile);
        }
        if (this.agentConfig.mediaFiles.length > 0) {
          extraMedia.push(...this.agentConfig.mediaFiles);
        }
      }

      await this.latexMediaManager.processInputFiles(
        inputFiles,
        workspaceState,
        this.agentConfig.toolConfig,
        this.modelHandler.capabilities.supportsVision,
        extraMedia,
      );
      return;
    }

    let outputFiles: FileLocation[] = this.agentConfig.outputFiles.map((f) =>
      this.fileService.createLocation(f),
    );
    if (outputFiles.length === 0) {
      const previousRoundFiles = this.outputHandler.ensureRound(currRound - 1);
      if (previousRoundFiles.length > 0) {
        outputFiles = [previousRoundFiles[0].location];
      }
    }

    if (outputFiles.length === 0) {
      return;
    }

    await this.latexMediaManager.processOutputFiles(
      outputFiles,
      workspaceState,
      this.agentConfig.toolConfig,
      this.modelHandler.capabilities.supportsVision,
    );
  }

  /**
   * Records the results of a reflection round into the agent's internal state
   * and clears the active round flag.
   *
   * **Execution Flow**:
   * 1. Flow calls `beginRound(roundIndex, runState, messages)` to initialize context
   * 2. Flow calls `executeCurrentRound()` to execute the round pipeline
   * 3. Flow calls `recordRoundResult(result)` to store results and complete the round
   *
   * **Success Path**: This method clears `isRoundActive` after storing results.
   * **Error Path**: `executeCurrentRound()` automatically clears `isRoundActive` in its catch block.
   *
   * **Important**: Always call this method after successful round execution. If not called,
   * the round context (currentMessages, currentRunState, etc.) will persist in memory
   * until the next successful round or error, though the isRoundActive flag prevents
   * starting new rounds, so this is primarily a memory concern rather than a correctness issue.
   *
   * @param result - The result returned by the reflection round execution
   */
  public recordRoundResult(result: ReflectionRoundResult): void {
    this.roundStates.push(result.roundState);
    this.workspaceStates.push(result.workspaceState);
    if (result.output) {
      this.roundOutputs[result.output.round] = result.output;
    }

    // Clear the active round flag to allow next round to begin
    this.isRoundActive = false;
  }

  /**
   * Executes the current round that was initialized with beginRound().
   * Flows should call beginRound() first to set up the context, then call this method.
   *
   * The isRoundActive flag is automatically cleared on error to prevent blocking future rounds.
   *
   * @returns The result of the round execution
   */
  public async executeCurrentRound(): Promise<ReflectionRoundResult> {
    if (!this.currentRunState || !this.currentWorkspaceState) {
      throw new Error(BaseReflectionAgent.ERR_ROUND_NOT_INITIALIZED);
    }

    try {
      const roundIndex = this.currentRoundIndex;
      const runState = this.currentRunState;
      const messages = this.currentMessages;
      const workspaceState = this.currentWorkspaceState;

      this.logger.debug(`Processing round ${roundIndex}`);

      return await this.withRoundStage(`r${roundIndex}`, async () => {
        // Prepare workspace state
        await this.prepareWorkspaceState();

        // Prepare round context
        const preparation = await this.prepareRoundContext();

        // Handle skip case
        if (preparation.skip) {
          return {
            roundState: preparation.stateRound,
            runState,
            messages,
            shouldContinue: true,
            workspaceState,
            output: null,
          };
        }

        // Execute round pipeline
        return await this.runRoundPipeline(
          preparation.stateRound,
          preparation.preparedMessages,
          preparation.prefill ?? '',
        );
      });
    } catch (error) {
      // Clear active flag and reset all context to prevent blocking future rounds
      this.isRoundActive = false;
      this.currentRoundIndex = 0;
      this.currentMessages = [];
      this.currentRunState = null;
      this.currentWorkspaceState = null;
      throw error;
    }
  }

  /**
   * Main execution method that processes inputs and generates outputs.
   */
  public async run(): Promise<void> {
    await this.awaitPendingHydration();

    const previousHydratedRounds = this.hydratedRoundCount;
    const hadHydratedRounds = previousHydratedRounds > 0;
    if (!hadHydratedRounds) {
      this.roundOutputs = [];
    }
    this.runtimeXmlExports = {
      tagContents: {},
      documents: [],
      singleOutputFile: null,
    };
    const lifecycle = createLifecycleState<ReflectionRunPhase>('idle');

    const totalRounds = this.getTotalRounds();

    try {
      await this.executeAgentRunFlow<ReflectionRunShared<C>>({
        lifecycle,
        createState: () =>
          ({
            totalRounds,
            currentRound: 0,
            continueRounds: true,
            conversation: [],
            runState: new AgentRunState(),
          }) satisfies ReflectionRunState,
        createFlow: () => createReflectionRunFlow<C>(),
        extendHooks: (baseHooks: AgentRunHooks) => {
          const baseStart = baseHooks.start;
          return {
            ...baseHooks,
            init: async (runStage) => {
              await this.init(runStage, { createStage: true });
            },
            start: async () => {
              const runStage = await baseStart();
              if (!runStage || !runStage.id) {
                throw new Error(
                  'Run group identifier is required for reflection runs.',
                );
              }
              // Update the context's storage key to the task group ID
              // This is THE key for all storage operations
              this.context.updateStorageKey(runStage.id);
              this.outputHandler.setActiveRun(runStage.id);
              return runStage;
            },
            resetPromptBuilder: () => this.resetPromptBuilder(),
          } satisfies ReflectionRunHooks;
        },
      });
    } finally {
      const currentOutputs = this.roundOutputs.filter(Boolean).length;
      this.hydratedRoundCount = Math.max(
        previousHydratedRounds,
        currentOutputs,
      );
    }

    this.runtimeXmlExports = this.computeRuntimeXmlExports();
  }

  protected computeRuntimeXmlExports(): AgentRuntimeXmlExports {
    const summary: AgentRuntimeXmlExports = {
      tagContents: {},
      documents: [],
      singleOutputFile: null,
    };

    // Find the most recent round with XML summary data
    // No need to search through cached roundOutputs - check in reverse order
    for (let round = this.roundOutputs.length - 1; round >= 0; round--) {
      const output = this.roundOutputs[round];
      if (!output) continue;

      const xml = output.xmlSummary;
      const hasData =
        Object.keys(xml.tagContents).length > 0 ||
        xml.documents.length > 0 ||
        xml.singleOutputFile !== null;

      if (hasData) {
        summary.tagContents = { ...xml.tagContents };
        summary.documents = [...xml.documents];
        summary.singleOutputFile = xml.singleOutputFile;
        break;
      }
    }

    return summary;
  }
}
