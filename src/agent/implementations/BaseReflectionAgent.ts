// Local imports - agent components
import type { IModelHandler } from '@agent/modelHandlers';
// Internal imports
import {
  OutputHandler,
  type IOutputHandler,
  type RoundOutput,
  type OutputFileInfo,
  type OutputXmlSummary,
} from '@agent/output';
import { getOutputFileName } from '@agent/utils/outputFileUtils';

// Type imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
import type { ExecutionId, StorageKey } from '@agent/types/IdentifierTypes';

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
  createReflectionFlow,
  type ReflectionFlowShared,
  type ReflectionServices,
} from '@agent/implementations/flows/reflection';
import {
  createInitialReflectionState,
  type ReflectionPhase,
} from '@agent/implementations/flows/reflection/ReflectionFlowState';

// Internal imports
import { AgentLifecycle } from '@agent/implementations/flows/common/AgentLifecycle';
import { createRetryState } from '@agent/core/flows/RetryState';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { normalizeRunId } from '@common/constants/runIds';
import type { AgentLogStage } from '@logger/AgentLogger';
import { PromptBuilder, writePromptToXml } from '@utils/prompt';

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
  public runtimeXmlExports: OutputXmlSummary = {
    tagContents: {},
    documents: [],
    singleOutputFile: null,
    sourceLocation: null,
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

  // =========================================================================
  // Service Provider Pattern
  // Agent provides services; flow nodes do the work using these services
  // =========================================================================

  /**
   * Get services for injection into flow nodes.
   *
   * Following the "Agent = Service Provider" pattern:
   * - Agent holds services but doesn't execute logic
   * - Flow nodes use these services via _params.services
   */
  public get services(): ReflectionServices<C> {
    return {
      modelHandler: this.modelHandler,
      outputHandler: this.outputHandler,
      latexMediaManager: this.latexMediaManager,
      promptBuilder: this.getPromptBuilder(),
      fileService: this.fileService,
      logger: this.logger,
      config: this.agentConfig,
      setting: this.agentSetting,
      prompt: this.agentPrompt,
      context: this.context,
      userVarChannels: this.userVarChannels,
      checkInterruption: () => this.isInterruptionRequested(),
      setAbortController: (ctrl) => {
        this.abortController = ctrl;
      },
      getClient: () => this.getClientInstance(),
      // Delegate to agent methods to preserve polymorphism
      getOutputFileLocation: (round) => this.getOutputFileLocation(round),
      shouldEnsureXmlStructure: () => this.shouldEnsureXmlStructure(),
    };
  }

  // =========================================================================
  // Lifecycle Overrides for Reflection Runs
  // Reflection agents have custom lifecycle: require run stage, set storageKey
  // =========================================================================

  /**
   * Reflection agents require a run stage for tracking.
   * Creates the stage, sets up storageKey, then initializes.
   */
  public override async startAndInitRun(): Promise<void> {
    // Start the run stage
    const runStage = await this.startRunStage();
    if (!runStage || !runStage.id) {
      throw new Error('Run group identifier is required for reflection runs.');
    }

    // Check if storageKey was already set by hydrateOutputState (resume case)
    // If still initial, this is a new run - set to task group ID
    if (this.context.hasInitialStorageKey()) {
      const storageKey = normalizeRunId(runStage.id);
      this.context.updateStorageKey(storageKey);
      this.outputHandler.setActiveRun(storageKey);
    }
    // For resumed runs, context.storageKey and outputHandler.activeRun
    // were already set by hydrateOutputState() - preserve them

    // Initialize with the run stage
    await this.init(runStage, { createStage: true });
  }

  public async hydrateOutputState(params: {
    executionId: ExecutionId;
    storageKey?: StorageKey | null;
    rounds: Map<number, OutputFileInfo[]>;
  }): Promise<void> {
    const hydration = (async () => {
      this.roundOutputs = [];
      this.fileService.updateRunContext(params.executionId);

      // Set the resumed storageKey on context and outputHandler BEFORE hydrating
      // This ensures subsequent events use the correct key
      if (params.storageKey) {
        this.context.updateStorageKey(params.storageKey);
        this.outputHandler.setActiveRun(params.storageKey);
      }

      this.outputHandler.hydrateFromArtifacts(
        params.storageKey ?? null,
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
        this.userVarChannels.transient,
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
    this.currentWorkspaceState = AgentWorkspaceState.create();
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
   *
   * For scratchpad mode (XML output), uses createRawOutputLocation() which always
   * routes to run storage when executionId is available. This keeps intermediate
   * XML artifacts isolated from the user's workspace.
   *
   * For direct output mode, uses createLocation() which respects the user's
   * storageMode preference.
   *
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

    // Route raw XML to isolated storage, direct outputs respect user preference
    return (
      this.useScratchpad
        ? this.fileService.createRawOutputLocation(fileName)
        : this.fileService.createLocation(fileName)
    ) as AgentFileLocation;
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
   * Determines whether XML structure should be ensured before processing.
   * Override in subclasses to customize behavior:
   * - DirectAgent: returns this.useScratchpad (only when scratchpad mode)
   * - CoTAgent: returns true (always ensure XML structure)
   */
  protected shouldEnsureXmlStructure(): boolean {
    return false;
  }

  /**
   * Processes output files for current round.
   * This method orchestrates the overall output processing flow:
   * 1. Ensures XML structure if needed (based on shouldEnsureXmlStructure)
   * 2. Processes output files via outputHandler
   * 3. Handles latexdiff operations (only when endTurn is true)
   *
   * @returns Array of processed output file paths
   */
  protected async handleOutput(
    currRound: number,
    _stateRound: ConversationRoundState,
    _runState: AgentRunState,
    options: RoundOutputOptions,
  ): Promise<OutputFileInfo[]> {
    const { outputFile, endTurn, stage } = options;

    // Process output files when turn ends
    if (endTurn) {
      this.logger.debug(`Processing output for round ${currRound}`);

      // Ensure XML structure if needed (subclass-specific behavior)
      if (this.shouldEnsureXmlStructure()) {
        await this.outputHandler.ensureXmlStructure(
          outputFile,
          this.agentSetting.documentTag,
        );
      }

      await this.outputHandler.processOutputFiles(outputFile, currRound, stage);
    }

    // Handle latexdiff operations if we have outputs
    if (endTurn && this.outputHandler.hasRoundOutputs(currRound)) {
      const existingBase = await Promise.all(
        this.baseFiles.map(async (f) => await flexibleFS.exists(f)),
      );

      if (existingBase.some((e) => e)) {
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

    // Helper to build consistent result object
    const buildResult = (
      endTurnFlag: boolean,
      output: RoundOutput | null,
      shouldContinue: boolean = this.shouldRunAnotherRound(endTurnFlag),
    ): ReflectionRoundResult => ({
      roundState: store.round,
      runState: store.run,
      messages: updatedMessages,
      shouldContinue,
      workspaceState: store.workspace,
      output,
    });

    // Early completion - model produced output directly via prefill
    if (endTurn) {
      await store.finalizeRound();
      const artifacts = await this.handleRoundCompletion(
        roundIndex,
        store.round,
        store.run,
        { outputFile: outputLocation, endTurn },
      );
      return buildResult(endTurn, artifacts);
    }

    // Normal flow - run response cycle
    const cycleResult = await runResponseCycle({
      options: this.createResponseCycleOptions(),
      messages: updatedMessages,
      outputLocation: outputLocation,
      store,
    });

    if (cycleResult.failedWithError) {
      throw new Error(
        cycleResult.errorMessage ?? 'Response cycle failed with an error',
      );
    }

    if (cycleResult.userCancelled) {
      return buildResult(cycleResult.endTurn, null, false);
    }

    const artifacts = await this.handleRoundCompletion(
      roundIndex,
      store.round,
      store.run,
      { outputFile: outputLocation, endTurn: cycleResult.endTurn },
    );

    return buildResult(cycleResult.endTurn, artifacts);
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
    const stateRound = new ConversationRoundState(currRound);

    return currRound === 0
      ? this.prepareFirstRoundContext(stateRound)
      : this.prepareSubsequentRoundContext(stateRound);
  }

  private async prepareFirstRoundContext(
    stateRound: ConversationRoundState,
  ): Promise<{
    stateRound: ConversationRoundState;
    preparedMessages: any[];
    prefill?: string;
    skip: boolean;
  }> {
    const workspaceState = this.currentWorkspaceState!;
    const promptBuilder = this.getPromptBuilder();

    const { systemPrompt, userRequest, userPrefix } =
      await promptBuilder.buildInitialPrompts();

    const prefixWithStats = this.prependTexcountStats(
      userPrefix,
      workspaceState,
    );

    await this.maybeSaveInputPrompt(systemPrompt, prefixWithStats, userRequest);

    const preparedMessages = await this.modelHandler.initializeMessages(
      prefixWithStats,
      userRequest,
      workspaceState.media.files,
      systemPrompt,
    );

    return this.finalizeRoundContext(stateRound, preparedMessages);
  }

  private async prepareSubsequentRoundContext(
    stateRound: ConversationRoundState,
  ): Promise<{
    stateRound: ConversationRoundState;
    preparedMessages: any[];
    prefill?: string;
    skip: boolean;
  }> {
    const workspaceState = this.currentWorkspaceState!;
    const messages = this.currentMessages;
    const promptBuilder = this.getPromptBuilder();

    const userRequest = await promptBuilder.buildUserRequest(
      this.currentRoundIndex,
    );
    const userMessage = this.prependTexcountStats(
      userRequest ? `${userRequest}\n` : '',
      workspaceState,
    );

    if (!userMessage.trim()) {
      return { stateRound, preparedMessages: messages, skip: true };
    }

    const preparedMessages = await this.modelHandler.createRoundMessages(
      messages,
      userMessage,
      workspaceState.media.files,
    );

    return this.finalizeRoundContext(stateRound, preparedMessages);
  }

  private prependTexcountStats(
    content: string,
    workspaceState: AgentWorkspaceState,
  ): string {
    const stats = workspaceState.document.texcountStats;
    return stats ? `${stats}${content}` : content;
  }

  private async maybeSaveInputPrompt(
    systemPrompt: string,
    userPrefix: string,
    userRequest: string,
  ): Promise<void> {
    if (!getConfig<boolean>('debug.saveInputPrompt', false)) return;

    const promptPath = await writePromptToXml(
      systemPrompt,
      userPrefix,
      userRequest,
      this.agentConfig.inputFile,
      this.agentConfig.agent,
      this.executionId,
    );
    this.logger.info(`Saved input prompt to ${promptPath}`);
  }

  private async finalizeRoundContext(
    stateRound: ConversationRoundState,
    preparedMessages: any[],
  ): Promise<{
    stateRound: ConversationRoundState;
    preparedMessages: any[];
    prefill?: string;
    skip: boolean;
  }> {
    const workspaceState = this.currentWorkspaceState!;
    const promptBuilder = this.getPromptBuilder();

    const prefill = await promptBuilder.buildPrefill(this.currentRoundIndex);
    workspaceState.assembly.updateAccumulatedOutput(prefill);

    return { stateRound, preparedMessages, prefill, skip: false };
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
      // Convert all media paths to FileLocation at entry point for consistency
      const extraMedia: FileLocation[] = [];

      if (this.modelHandler.capabilities.supportsVision) {
        if (this.agentConfig.mediaFile) {
          const mediaLocation = this.fileService.createLocation(
            this.agentConfig.mediaFile,
          );
          if (!workspaceState.media.hasFile(mediaLocation.absolutePath)) {
            extraMedia.push(mediaLocation);
          }
        }
        for (const mediaPath of this.agentConfig.mediaFiles) {
          const mediaLocation = this.fileService.createLocation(mediaPath);
          if (!workspaceState.media.hasFile(mediaLocation.absolutePath)) {
            extraMedia.push(mediaLocation);
          }
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
   *
   * Uses the pure PocketFlow ReflectionFlow architecture:
   * - Agent = Service Provider (provides services via getter)
   * - Flow = Execution Engine (all logic lives in flow nodes)
   * - Services injected via flow.setParams()
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
      sourceLocation: null,
    };

    const totalRounds = this.getTotalRounds();
    const lifecycle = new AgentLifecycle<ReflectionPhase>('idle');

    // Create shared state for the flow
    const shared: ReflectionFlowShared = {
      agent: this,
      state: createInitialReflectionState(
        totalRounds,
        AgentWorkspaceState.create(),
      ),
      lifecycle,
      hooks: {
        resetPromptBuilder: () => this.resetPromptBuilder(),
      },
      retryState: createRetryState(),
    };

    try {
      // Create flow and inject services
      const flow = createReflectionFlow<C>();
      flow.setParams({ services: this.services });

      // Run the flow
      await flow.run(shared);

      // Check for errors
      if (lifecycle.error) {
        throw lifecycle.error;
      }

      // Sync state from flow to agent
      this.roundOutputs = shared.state.roundOutputs;
      this.roundStates = shared.state.roundStates;
    } finally {
      const currentOutputs = this.roundOutputs.filter(Boolean).length;
      this.hydratedRoundCount = Math.max(
        previousHydratedRounds,
        currentOutputs,
      );
    }

    this.runtimeXmlExports = this.computeRuntimeXmlExports();
  }

  protected computeRuntimeXmlExports(): OutputXmlSummary {
    // Find the most recent round with XML summary data
    for (let round = this.roundOutputs.length - 1; round >= 0; round--) {
      const output = this.roundOutputs[round];
      if (!output) continue;

      const xml = output.xmlSummary;
      const hasData =
        Object.keys(xml.tagContents).length > 0 ||
        xml.documents.length > 0 ||
        xml.singleOutputFile !== null;

      if (hasData) {
        // Return a copy of the xmlSummary - this IS the single source of truth
        return {
          tagContents: { ...xml.tagContents },
          documents: [...xml.documents],
          singleOutputFile: xml.singleOutputFile,
          sourceLocation: xml.sourceLocation,
        };
      }
    }

    return {
      tagContents: {},
      documents: [],
      singleOutputFile: null,
      sourceLocation: null,
    };
  }
}
