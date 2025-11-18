// Standard library imports
import * as path from 'path';

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
// Type imports
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
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
// Type imports
import type { AgentRunHooks } from '@agent/implementations/flows/common/types';
// Internal imports
import { createLifecycleState } from '@agent/implementations/flows/common/lifecycle';
import {
  createReflectionRoundFlow,
  type ReflectionRoundShared,
} from '@agent/implementations/flows/ReflectionRoundFlow';
// Internal imports
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { PromptBuilder } from '@agent/utils/PromptBuilder';
import { writePromptToXml } from '@agent/utils/promptUtils';
// Type imports
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentLogStage } from '@logger/AgentLogger';

// Local imports - configuration
import { getConfig } from '@utils/config';
import {
  WorkspaceFS,
  TaskRunFileService,
  pathToLocation,
  type FileLocation,
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
  runGroupId?: string | null;
}

export interface ReflectionRoundContext {
  roundIndex: number;
  runState: AgentRunState;
  messages: any[];
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

interface RoundPipelineContext {
  roundIndex: number;
  roundState: ConversationRoundState;
  runState: AgentRunState;
  workspaceState: AgentWorkspaceState;
  preparedMessages: any[];
  prefill: string;
  outputLocation: FileLocation;
}

/**
 * Abstract base class for agents that support multi-turn reflection.
 * Provides core functionality for processing inputs, managing state, and handling outputs
 * across multiple conversation rounds.
 */
export abstract class BaseReflectionAgent<C = unknown> extends BaseAgent<C> {
  /** File paths for each round's raw model output. */
  protected outputFile: FileLocation[];
  protected outputFiles: { [key: number]: FileLocation[] };
  protected baseFiles: FileLocation[];
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

    this.outputFile = new Array<FileLocation>(numRounds);
    this.outputFiles = {};
    for (let i = 0; i < numRounds; i++) {
      this.outputFiles[i] = [];
    }
    // Use fileService.createLocation for run-storage awareness
    this.baseFiles =
      this.agentConfig.outputFiles.length > 0
        ? this.agentConfig.outputFiles.map((f) =>
            this.fileService.createLocation(f),
          )
        : [this.fileService.createLocation(this.agentConfig.inputFile)];

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

  protected resetPromptBuilder(): void {
    this.promptBuilder = undefined;
  }

  public setCurrentRound(roundIndex: number): void {
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
   */
  protected getOutputFileLocation(currRound: number): FileLocation {
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

    return this.fileService.createLocation(fileName);
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
    const runGroupId =
      options.runGroupId ??
      this.runStage?.id ??
      this.getLastRunGroupId() ??
      null;
    this.outputHandler.setActiveRun(runGroupId);

    const baseOptions: RoundOutputOptions = {
      ...options,
      runGroupId,
    };

    const { outputFile, endTurn, stage } = baseOptions;

    const execute = async (scope: AgentLogStage | undefined) => {
      await this.handleOutput(currRound, stateRound, runState, {
        ...baseOptions,
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
    stateRound: ConversationRoundState,
    _runState: AgentRunState,
    options: RoundOutputOptions,
  ): Promise<OutputFileInfo[]> {
    const { outputFile, endTurn, stage } = options;
    this.outputHandler.setActiveRun(options.runGroupId);
    // If this is the end of a turn, handle latexdiff operations as a separate step
    if (endTurn && this.outputHandler.hasRoundOutputs(currRound)) {
      const existingBase = await Promise.all(
        this.baseFiles.map(
          async (f) => await WorkspaceFS.exists(f.absolutePath),
        ),
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
   * Executes the shared round lifecycle pipeline used by both processing and reflection flows.
   * Handles output initialization, response generation, and round finalization to keep
   * lifecycle responsibilities centralized.
   *
   * @param currRound - Zero-based index of the round being executed.
   * @param stateRound - Mutable state scoped to the current round of execution.
   * @param runState - Shared agent state that spans all rounds.
   * @param workspaceState - Current tool invocation state passed between rounds.
   * @param preparedMessages - Messages prepared for the model before execution.
   * @param prefill - Initial text inserted into the model response buffer.
   * @param outputLocation - File location where model output for this round is stored.
   * @returns Updated round/global state, messages, completion flag, and tool state after execution.
   */
  private async runRoundPipeline({
    roundIndex,
    roundState,
    runState,
    workspaceState,
    preparedMessages,
    prefill,
    outputLocation,
  }: RoundPipelineContext): Promise<ReflectionRoundResult> {
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
      const runGroupId = this.runStage?.id ?? this.getLastRunGroupId() ?? null;
      const cycleResult = await runResponseCycle({
        options: this.createResponseCycleOptions(),
        messages: updatedMessages,
        outputLocation: outputLocation,
        store,
      });

      const artifacts = await this.handleRoundCompletion(
        roundIndex,
        store.round,
        store.run,
        {
          outputFile: outputLocation,
          endTurn: cycleResult.endTurn,
          runGroupId,
        },
      );

      return {
        roundState: store.round,
        runState: store.run,
        messages: updatedMessages,
        shouldContinue: cycleResult.endTurn,
        workspaceState: store.workspace,
        output: artifacts,
      };
    }

    await store.finalizeRound();

    const runGroupId = this.runStage?.id ?? this.getLastRunGroupId() ?? null;
    const artifacts = await this.handleRoundCompletion(
      roundIndex,
      store.round,
      store.run,
      {
        outputFile: outputLocation,
        endTurn,
        runGroupId,
      },
    );

    return {
      roundState: store.round,
      runState: store.run,
      messages: updatedMessages,
      shouldContinue: endTurn,
      workspaceState,
      output: artifacts,
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
      fileService: this.fileService,
    };
  }

  private async prepareRoundContext(
    currRound: number,
    _runState: AgentRunState,
    messages: any[],
    workspaceState: AgentWorkspaceState,
  ): Promise<{
    stateRound: ConversationRoundState;
    preparedMessages: any[];
    prefill?: string;
    skip: boolean;
  }> {
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

  private async prepareAgentWorkspaceState(
    currRound: number,
    workspaceState: AgentWorkspaceState,
  ): Promise<void> {
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

  public async runReflectionRound({
    roundIndex,
    runState,
    messages,
  }: ReflectionRoundContext): Promise<ReflectionRoundResult> {
    this.logger.debug(`Processing round ${roundIndex}`);
    const workspaceState = new AgentWorkspaceState();

    return this.withRoundStage(`r${roundIndex}`, async () => {
      const shared: ReflectionRoundShared = {
        runtime: {
          workspaceState,
        },
        hooks: {
          prepareAgentWorkspaceState: () =>
            this.prepareAgentWorkspaceState(roundIndex, workspaceState),
          prepareRoundContext: () =>
            this.prepareRoundContext(
              roundIndex,
              runState,
              messages,
              workspaceState,
            ),
          runRoundPipeline: ({ stateRound, preparedMessages, prefill }) =>
            this.runRoundPipeline({
              roundIndex,
              roundState: stateRound,
              runState,
              workspaceState,
              preparedMessages,
              prefill,
              outputLocation: this.outputFile[roundIndex],
            }),
          createSkipResult: (stateRound) => ({
            roundState: stateRound,
            runState,
            messages,
            shouldContinue: true,
            workspaceState,
            output: null,
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
              if (!runStage) {
                throw new Error(
                  'Run group identifier is required for reflection runs.',
                );
              }
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
