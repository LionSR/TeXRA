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
import type { ExecutionId, StorageKey } from '@agent/types/IdentifierTypes';

// Internal imports
import {
  AgentSetting,
  AgentPrompt,
  AgentWorkflowSetting,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';

// Internal imports
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { BaseAgent } from '@agent/implementations/BaseAgent';
import {
  createReflectionFlow,
  type ReflectionFlowShared,
  type ReflectionServices,
} from '@agent/implementations/flows/reflection';
import { createInitialReflectionState } from '@agent/implementations/flows/reflection/ReflectionFlowState';

// Internal imports
import { createRetryState } from '@agent/core/flows/RetryState';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import { normalizeRunId } from '@common/constants/runIds';
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';
import { PromptBuilder } from '@utils/prompt';
import {
  WorkspaceFS,
  TaskRunFileService,
  createWorkspaceLocation,
  type AgentFileLocation,
} from '@utils/files';
import { LatexMediaManager } from '@latex';

/**
 * Parameters for resuming a reflection agent from saved state.
 * Used by prepareResume() to store resume configuration before run().
 */
export interface ResumeParams {
  /** The execution ID to resume */
  executionId: ExecutionId;
  /** Storage key for accessing saved artifacts */
  storageKey?: StorageKey | null;
  /** Map of round number to saved output file info */
  rounds: Map<number, OutputFileInfo[]>;
}

/**
 * Abstract base class for agents that support multi-turn reflection.
 * Provides core functionality for processing inputs, managing state, and handling outputs
 * across multiple conversation rounds.
 */
export abstract class BaseReflectionAgent<C = unknown> extends BaseAgent<C> {
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
  public roundOutputs: RoundOutput[] = [];
  public runtimeXmlExports: OutputXmlSummary = {
    tagContents: {},
    documents: [],
    singleOutputFile: null,
    sourceLocation: null,
  };
  protected readonly fileService: TaskRunFileService;
  /** Pending resume parameters, set by prepareResume() and consumed by startAndInitRun() */
  private resumeParams: ResumeParams | null = null;
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
      getUsageRecorder: () => this.getUsageRecorder('workflow'),
    };
  }

  // =========================================================================
  // Lifecycle Overrides for Reflection Runs
  // Reflection agents have custom lifecycle: require run stage, set storageKey
  // =========================================================================

  /**
   * Prepare agent for resuming from saved state.
   *
   * This is a synchronous setup method that stores resume parameters.
   * The actual hydration happens in startAndInitRun(), eliminating
   * temporal coupling between separate async operations.
   *
   * @param params Resume parameters containing executionId, storageKey, and saved rounds
   */
  public prepareResume(params: ResumeParams): void {
    this.resumeParams = params;
  }

  /**
   * Check if this agent is configured for resume.
   */
  public isResuming(): boolean {
    return this.resumeParams !== null;
  }

  /**
   * Reflection agents require a run stage for tracking.
   * Creates the stage, sets up storageKey, handles resume hydration, then initializes.
   *
   * Resume hydration now happens here (Option A pattern), eliminating the need for
   * separate awaitPendingHydration() calls and temporal coupling between methods.
   */
  public override async startAndInitRun(): Promise<void> {
    // Handle resume hydration first (Option A: consolidate into lifecycle)
    if (this.resumeParams) {
      await this.hydrateFromResume(this.resumeParams);
      this.resumeParams = null;
    }

    // Start the run stage
    const runStage = await this.startRunStage();
    if (!runStage || !runStage.id) {
      throw new Error('Run group identifier is required for reflection runs.');
    }

    // For new runs (not resume), set storageKey to task group ID
    // For resumed runs, storageKey was already set by hydrateFromResume()
    if (this.context.hasInitialStorageKey()) {
      const storageKey = normalizeRunId(runStage.id);
      this.context.updateStorageKey(storageKey);
      this.outputHandler.setActiveRun(storageKey);
    }

    // Initialize with the run stage
    await this.init(runStage, { createStage: true });
  }

  /**
   * Hydrate agent state from saved resume parameters.
   *
   * Single Source of Truth: agent.roundOutputs[] is the canonical storage
   * for round results during runtime. OutputHandler.rounds is only used
   * transiently during active file processing within a round - it does NOT
   * persist across runs or resume.
   *
   * On resume, we create RoundOutput objects directly in agent.roundOutputs[]
   * without going through OutputHandler. This is intentional - OutputHandler
   * is a processing utility, not a persistence layer.
   */
  private async hydrateFromResume(params: ResumeParams): Promise<void> {
    this.roundOutputs = [];
    this.fileService.updateRunContext(params.executionId);

    // Set the resumed storageKey on context and outputHandler
    if (params.storageKey) {
      this.context.updateStorageKey(params.storageKey);
      this.outputHandler.setActiveRun(params.storageKey);
    }

    // Sort rounds for consistent ordering
    const sortedRounds = Array.from(params.rounds.keys()).sort((a, b) => a - b);

    // Create RoundOutput objects directly in agent.roundOutputs[] (canonical storage)
    for (const round of sortedRounds) {
      const savedOutputs = params.rounds.get(round) ?? [];
      this.roundOutputs[round] = {
        round,
        rawOutput: null, // Not available from saved state
        outputs: savedOutputs,
        xmlSummary: {
          tagContents: {},
          documents: [],
          singleOutputFile: null,
          sourceLocation: null,
        },
      };
    }

    this.hydratedRoundCount = sortedRounds.length;
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
   * Determines whether XML structure should be ensured before processing.
   * Override in subclasses to customize behavior:
   * - DirectAgent: returns this.useScratchpad (only when scratchpad mode)
   * - CoTAgent: returns true (always ensure XML structure)
   */
  protected shouldEnsureXmlStructure(): boolean {
    return false;
  }

  /**
   * Main execution method that processes inputs and generates outputs.
   *
   * Architecture:
   * - Agent = Service Provider (provides services via getter)
   * - Flow = Execution Engine (all logic lives in flow nodes)
   * - Agent owns lifecycle (init before flow, finalize in finally)
   *
   * Lifecycle pattern:
   * - Init: startAndInitRun() (handles resume hydration), initializeClient(), resetPromptBuilder()
   * - Flow: Pure execution logic, throws on error
   * - Finalize: endRun(status), cleanupRun() in finally block
   *
   * Resume handling:
   * - prepareResume() called before run() stores resume params
   * - startAndInitRun() checks for resume params and hydrates state
   * - No temporal coupling - all resume logic in lifecycle methods
   */
  public async run(): Promise<void> {
    // Note: Resume hydration happens in startAndInitRun() when resumeParams is set
    // This eliminates the temporal coupling of the old awaitPendingHydration() pattern

    // Reset runtime exports before run
    this.runtimeXmlExports = {
      tagContents: {},
      documents: [],
      singleOutputFile: null,
      sourceLocation: null,
    };

    let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
    let shared: ReflectionFlowShared | undefined;
    let previousHydratedRounds = 0;

    try {
      // === INIT (agent-owns-lifecycle) ===
      // Init inside try block ensures cleanup runs even if init fails
      await this.startAndInitRun();
      await this.initializeClient();
      this.resetPromptBuilder();

      // Check hydration state AFTER startAndInitRun (which calls hydrateFromResume)
      previousHydratedRounds = this.hydratedRoundCount;
      const hadHydratedRounds = previousHydratedRounds > 0;
      if (!hadHydratedRounds) {
        this.roundOutputs = [];
      }

      const totalRounds = this.getTotalRounds();

      // Ensure we have a run stage for round grouping
      if (!this.runStage) {
        throw new Error('Run stage required for reflection agent.');
      }

      // Determine starting round from hydrated outputs (for resume)
      const startingRound = hadHydratedRounds ? this.roundOutputs.length : 0;

      // Create initial round stage for UI grouping (r0, r1, etc.)
      const roundStageName = `r${startingRound}`;
      const roundStage = await this.logger.stage(roundStageName, {
        parent: this.runStage,
      });

      // Create shared state for the flow (no lifecycle - errors thrown directly)
      // Pass hydrated outputs to preserve them during resume
      shared = {
        agent: this,
        state: createInitialReflectionState(
          totalRounds,
          AgentWorkspaceState.create(),
          hadHydratedRounds ? this.roundOutputs : undefined,
        ),
        retryState: createRetryState(),
        runStage: this.runStage,
      };

      // Set initial round stage
      shared.state.roundStage = roundStage;

      // Create flow and inject services (native service pattern)
      const flow = createReflectionFlow<C>();
      flow.setServices(this.services);

      // Run the flow - errors throw directly
      await flow.run(shared);

      // Sync state from flow to agent
      this.roundOutputs = shared.state.roundOutputs;
      this.roundStates = shared.state.roundStates;
    } catch (error) {
      status = END_GROUP_STATUS.ERROR;
      throw error;
    } finally {
      // === FINALIZE (agent-owns-lifecycle) ===
      shared?.state.roundStage?.end(status);

      const currentOutputs = this.roundOutputs.filter(Boolean).length;
      this.hydratedRoundCount = Math.max(
        previousHydratedRounds,
        currentOutputs,
      );

      this.endRun(status);
      this.cleanupRun();
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
