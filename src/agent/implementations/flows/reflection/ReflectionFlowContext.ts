/**
 * ReflectionFlowContext - Self-contained execution context for reflection flows.
 *
 * Creates and owns all services needed by ReflectionFlow:
 * - OutputHandler for structured output processing
 * - PromptBuilder for template rendering
 * - LatexMediaManager for media handling
 * - TaskRunFileService for file operations
 *
 * Behavior is configuration-driven via `xmlStructureMode` and `maxRounds`,
 * not class inheritance.
 */

import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type {
  AgentPrompt,
  AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';
import type { AgentRoundFinalizedCallback } from '@agent/core/AgentSharedStore';
import type { AgentFileLocation } from '@utils/files';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import { BaseFlowContext } from '@agent/implementations/flows/common';
import type { IInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';

import { OutputHandler, type IOutputHandler } from '@agent/output';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { LatexMediaManager } from '@latex';
import { PromptBuilder } from '@utils/prompt';
import { TaskRunFileService } from '@utils/files';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { createBaseFileLocations } from './helpers';
import type { ReflectionServices } from './ReflectionServices';

// ============================================================================
// Context Initialization
// ============================================================================

/**
 * Configuration for creating a ReflectionFlowContext.
 *
 * Extends BaseFlowContextInit with reflection-specific fields.
 * The context factory creates all derived services from these.
 */
export interface ReflectionFlowContextInit<
  C = unknown,
> extends BaseFlowContextInit<C> {
  /** Narrow setting to workflow-specific type */
  setting: AgentWorkflowSetting;

  /** Usage tracking callback (required for reflection flows) */
  getUsageRecorder: () => AgentRoundFinalizedCallback;

  /**
   * Optional custom output file location getter.
   * When provided, overrides the default file naming logic.
   * Used by merge operations which have specialized naming conventions.
   */
  getOutputFileLocation?: (round: number) => AgentFileLocation;
}

// ============================================================================
// Behavior Computation
// ============================================================================

/**
 * Compute whether XML structure should be ensured based on configuration.
 *
 * Priority order:
 * 1. `setting.xmlStructureMode` - explicit YAML configuration
 * 2. `agentType: 'CoT'` - implies always ensure XML structure
 * 3. `agentType: 'direct'` - implies scratchpadOnly mode
 * 4. Default: false (no XML structure enforcement)
 */
function computeShouldEnsureXmlStructure(
  setting: AgentWorkflowSetting,
): boolean {
  const useScratchpad = setting.prefills?.includes('<scratchpad>') ?? false;

  // 1. Explicit xmlStructureMode takes highest precedence
  if (setting.xmlStructureMode !== undefined) {
    switch (setting.xmlStructureMode) {
      case 'always':
        return true;
      case 'scratchpadOnly':
        return useScratchpad;
      case 'never':
      default:
        return false;
    }
  }

  // 2. agentType-driven: 'CoT' implies always ensure XML structure
  if (setting.agentType === 'CoT') {
    return true;
  }

  // 3. agentType-driven: 'direct' implies scratchpadOnly mode
  if (setting.agentType === 'direct') {
    return useScratchpad;
  }

  // 4. Default behavior (no explicit type or config)
  return false;
}

/**
 * Compute total rounds based on configuration.
 *
 * Priority order:
 * 1. `setting.maxRounds` - explicit YAML configuration
 * 2. `agentType: 'direct'` - implies single-round execution (maxRounds=1)
 * 3. Default calculation - max(configured rounds, userRequest array length)
 */
function computeTotalRounds(
  setting: AgentWorkflowSetting,
  prompt: AgentPrompt,
): number {
  // 1. Explicit maxRounds config takes highest precedence
  if (setting.maxRounds !== undefined) {
    return setting.maxRounds;
  }

  // 2. agentType-driven: 'direct' implies single-round execution
  if (setting.agentType === 'direct') {
    return 1;
  }

  // 3. Default behavior for CoT and other types
  const requestArray = Array.isArray(prompt.userRequest)
    ? prompt.userRequest
    : prompt.userRequest
      ? [prompt.userRequest]
      : [];
  return Math.max(setting.rounds ?? 2, requestArray.length);
}

/**
 * Compute output file location for a given round.
 *
 * This replaces the polymorphic getOutputFileLocation() method.
 * MergeAgent has special logic that would need a separate strategy.
 */
function createOutputFileLocationGetter(
  config: AgentConfig,
  setting: AgentWorkflowSetting,
  modelHandler: IModelHandler<any, any, any, any, any>,
  fileService: TaskRunFileService,
): (round: number) => AgentFileLocation {
  const useScratchpad = setting.prefills?.includes('<scratchpad>') ?? false;

  return (currRound: number): AgentFileLocation => {
    const baseOutputFile = config.inputFile;
    const fileExtension = useScratchpad ? 'xml' : setting.outputExt;

    const fileName = getOutputFileName(
      baseOutputFile,
      config.agent,
      modelHandler.config.name,
      fileExtension,
      currRound,
      config.editedFile || undefined,
    );

    // Route raw XML to isolated storage, direct outputs respect user preference
    return (
      useScratchpad
        ? fileService.createRawOutputLocation(fileName)
        : fileService.createLocation(fileName)
    ) as AgentFileLocation;
  };
}

// ============================================================================
// Context Class
// ============================================================================

/**
 * Self-contained execution context for reflection flows.
 *
 * Creates all services internally and computes behavior from configuration.
 * No agent class instance is needed.
 *
 * Extends BaseFlowContext for shared lazy initialization pattern.
 * Implements IInterruptible for unified interrupt handling via registry.
 */
export class ReflectionFlowContext<C = unknown>
  extends BaseFlowContext<ReflectionFlowContextInit<C>, ReflectionServices<C>, C>
  implements IInterruptible
{
  // Services created internally
  private _outputHandler: IOutputHandler | null = null;
  private _promptBuilder: PromptBuilder | null = null;
  private _latexMediaManager: LatexMediaManager | null = null;
  private _fileService: TaskRunFileService | null = null;

  // Computed values
  private _totalRounds: number | null = null;
  private _shouldEnsureXmlStructure: boolean | null = null;

  constructor(init: ReflectionFlowContextInit<C>) {
    super(init);
  }

  // =========================================================================
  // Service Creation (lazy initialization)
  // =========================================================================

  private get fileService(): TaskRunFileService {
    if (!this._fileService) {
      this._fileService = new TaskRunFileService(
        this.init.executionContext.executionId,
      );
    }
    return this._fileService;
  }

  private get baseFiles(): AgentFileLocation[] {
    return createBaseFileLocations(this.init.config);
  }

  private get outputHandler(): IOutputHandler {
    if (!this._outputHandler) {
      this._outputHandler = new OutputHandler(
        this.init.setting,
        this.init.config,
        0, // logId
        this.baseFiles,
        this.init.executionContext.logger,
        this.fileService,
        this.init.executionContext.executionId,
      );
    }
    return this._outputHandler;
  }

  private get promptBuilder(): PromptBuilder {
    if (!this._promptBuilder) {
      this._promptBuilder = new PromptBuilder(
        this.init.prompt,
        this.init.setting,
        this.init.userVarChannels.transient,
        this.init.executionContext.logger,
      );
    }
    return this._promptBuilder;
  }

  private get latexMediaManager(): LatexMediaManager {
    if (!this._latexMediaManager) {
      this._latexMediaManager = new LatexMediaManager(
        this.init.executionContext.logger,
        this.fileService,
      );
    }
    return this._latexMediaManager;
  }

  // =========================================================================
  // Computed Behavior
  // =========================================================================

  get totalRounds(): number {
    if (this._totalRounds === null) {
      this._totalRounds = computeTotalRounds(
        this.init.setting,
        this.init.prompt,
      );
    }
    return this._totalRounds;
  }

  get shouldEnsureXmlStructure(): boolean {
    if (this._shouldEnsureXmlStructure === null) {
      this._shouldEnsureXmlStructure = computeShouldEnsureXmlStructure(
        this.init.setting,
      );
    }
    return this._shouldEnsureXmlStructure;
  }

  // =========================================================================
  // BaseFlowContext Implementation
  // =========================================================================

  /**
   * Build reflection-specific services.
   *
   * Called by BaseFlowContext.services getter after base services are built.
   * Returns services that are merged on top of base services.
   */
  protected buildFlowSpecificServices(): Partial<ReflectionServices<C>> {
    const { config, setting, getUsageRecorder } = this.init;

    // Use custom getter if provided, otherwise create default
    const getOutputFileLocation =
      this.init.getOutputFileLocation ??
      createOutputFileLocationGetter(
        config,
        setting,
        this.init.modelHandler,
        this.fileService,
      );

    return {
      // Narrow setting type for reflection flows
      setting,

      // Services created by context
      outputHandler: this.outputHandler,
      latexMediaManager: this.latexMediaManager,
      promptBuilder: this.promptBuilder,
      fileService: this.fileService,

      // Strategies computed from configuration (no callbacks to agent!)
      getOutputFileLocation,
      shouldEnsureXmlStructure: () => this.shouldEnsureXmlStructure,
      getUsageRecorder,
    };
  }

  // =========================================================================
  // Lifecycle helpers
  // =========================================================================

  /**
   * Reset the prompt builder (call before each run).
   */
  resetPromptBuilder(): void {
    this._promptBuilder = null;
  }

  /**
   * Set the active run storage key on the output handler.
   */
  setActiveRun(storageKey: string): void {
    this.outputHandler.setActiveRun(storageKey as any);
  }

  // =========================================================================
  // IInterruptible Implementation
  // =========================================================================

  /**
   * Interrupt the flow execution.
   * Notifies the runtime layer via onInterrupt callback and cleans up retry state.
   */
  interrupt(): void {
    this.init.onInterrupt?.();

    // Clear any pending retry request to avoid memory leaks
    retryCoordinator.clearRequest(this.init.executionContext.streamId);
  }

  // =========================================================================
  // Lifecycle - Cleanup
  // =========================================================================

  /**
   * Dispose context resources.
   * Clears cached services to allow garbage collection.
   * Should be called in finally block after flow execution.
   */
  dispose(): void {
    this._outputHandler = null;
    this._promptBuilder = null;
    this._latexMediaManager = null;
    this._fileService = null;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a ReflectionFlowContext with all services and behaviors configured.
 *
 * This is the primary entry point for setting up flow execution without
 * needing an agent class instance.
 */
export function createReflectionFlowContext<C = unknown>(
  init: ReflectionFlowContextInit<C>,
): ReflectionFlowContext<C> {
  return new ReflectionFlowContext(init);
}

/**
 * Creates a ReflectionFlowContext ready for execution.
 *
 * Encapsulates the lifecycle setup that was previously done manually:
 * - resetPromptBuilder() - clears cached prompt state
 * - setActiveRun(storageKey) - configures output handler for this run
 *
 * This eliminates the error-prone manual setup pattern:
 * ```
 * // Old pattern (error-prone):
 * const context = new ReflectionFlowContext(init);
 * context.resetPromptBuilder();  // Easy to forget!
 * context.setActiveRun(storageKey);  // Easy to forget!
 *
 * // New pattern:
 * const context = createReadyReflectionContext(init, storageKey);
 * ```
 */
export function createReadyReflectionContext<C = unknown>(
  init: ReflectionFlowContextInit<C>,
  storageKey: string,
): ReflectionFlowContext<C> {
  const context = new ReflectionFlowContext(init);
  context.resetPromptBuilder();
  context.setActiveRun(storageKey);
  return context;
}
