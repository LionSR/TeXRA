/**
 * ReflectionFlowContext - Simple factory function for reflection flow services.
 *
 * Creates all services needed by ReflectionFlow:
 * - OutputHandler for structured output processing
 * - PromptBuilder for template rendering
 * - LatexMediaManager for media handling
 * - TaskRunFileService for file operations
 *
 * Behavior is configuration-driven via `xmlStructureMode` and `maxRounds`,
 * not class inheritance.
 */

import type { IModelHandler } from '@agent/modelHandlers';
import { OutputHandler, type IOutputHandler } from '@agent/output';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type {
  AgentPrompt,
  AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';
import type { AgentRoundFinalizedCallback } from '@agent/core/AgentSharedStore';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import type { StorageKey } from '@agent/types/IdentifierTypes';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import type { AgentFileLocation } from '@utils/files';

import { PromptBuilder } from '@utils/prompt';
import { TaskRunFileService } from '@utils/files';
import { LatexMediaManager } from '@latex';
import { createBaseFileLocations } from './helpers';
import { buildBaseFlowServices } from '../common';
import type {
  ReflectionServices,
  ReflectionServicesPartial,
} from './ReflectionServices';

// ============================================================================
// Context Initialization
// ============================================================================

/**
 * Configuration for creating reflection flow services.
 *
 * Extends BaseFlowContextInit with reflection-specific fields.
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
// Context Object (simple object, not a class)
// ============================================================================

/**
 * Reflection flow context returned by factory function.
 * Contains services and lifecycle methods.
 */
export interface ReflectionFlowContext<C = unknown> {
  /** Services for flow execution (missing runStage - set by runReflectionFlow) */
  services: ReflectionServicesPartial<C>;

  /** Total number of rounds to execute */
  totalRounds: number;

  /** Set the active run storage key on the output handler */
  setActiveRun(storageKey: StorageKey): void;

  /** Interrupt the flow execution */
  interrupt(): void;

  /** Dispose context resources */
  dispose(): void;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Build reflection flow services from initialization config.
 *
 * This is the PocketFlow-native way: simple factory function that creates
 * all services eagerly and returns them as a plain object.
 *
 * Note: Returns partial services (missing runStage). The runStage is added
 * by runReflectionFlow after the run stage is created/provided.
 */
export function buildReflectionServices<C = unknown>(
  init: ReflectionFlowContextInit<C>,
): ReflectionServicesPartial<C> {
  const {
    config,
    setting,
    modelHandler,
    executionContext,
    prompt,
    userVarChannels,
    getUsageRecorder,
  } = init;

  // Create services eagerly (no lazy initialization)
  const fileService = new TaskRunFileService(executionContext.executionId);
  const baseFiles = createBaseFileLocations(config);

  const outputHandler = new OutputHandler(
    setting,
    config,
    0, // logId
    baseFiles,
    executionContext.logger,
    fileService,
    executionContext.executionId,
  );

  const promptBuilder = new PromptBuilder(
    prompt,
    setting,
    userVarChannels.transient,
    executionContext.logger,
  );

  const latexMediaManager = new LatexMediaManager(
    executionContext.logger,
    fileService,
  );

  // Compute behavior from configuration
  const shouldEnsureXmlStructure = computeShouldEnsureXmlStructure(setting);

  // Use custom getter if provided, otherwise create default
  const getOutputFileLocation =
    init.getOutputFileLocation ??
    createOutputFileLocationGetter(config, setting, modelHandler, fileService);

  // Build base services
  const baseServices = buildBaseFlowServices(init);

  // Return partial services (missing runStage - added by runReflectionFlow)
  // Round stages (r0, r1...) are managed by RoundPersistedFlow, not by services
  return {
    ...baseServices,
    setting,
    outputHandler,
    latexMediaManager,
    promptBuilder,
    fileService,
    getOutputFileLocation,
    shouldEnsureXmlStructure: () => shouldEnsureXmlStructure,
    getUsageRecorder,
  };
}

/**
 * Creates a ReflectionFlowContext with all services and behaviors configured.
 *
 * This is the primary entry point for setting up flow execution.
 * Returns a simple object with services and lifecycle methods.
 */
export function createReflectionFlowContext<C = unknown>(
  init: ReflectionFlowContextInit<C>,
): ReflectionFlowContext<C> {
  const services = buildReflectionServices(init);
  const totalRounds = computeTotalRounds(init.setting, init.prompt);

  return {
    services,
    totalRounds,

    setActiveRun(storageKey: StorageKey): void {
      services.outputHandler.setActiveRun(storageKey);
    },

    interrupt(): void {
      init.onInterrupt?.();
      retryCoordinator.clearRequest(init.executionContext.streamId);
    },

    dispose(): void {
      retryCoordinator.clearRequest(init.executionContext.streamId);
    },
  };
}

/**
 * Creates a ReflectionFlowContext ready for execution.
 *
 * Encapsulates lifecycle setup:
 * - setActiveRun(storageKey) - configures output handler for this run
 */
export function createReadyReflectionContext<C = unknown>(
  init: ReflectionFlowContextInit<C>,
  storageKey: StorageKey,
): ReflectionFlowContext<C> {
  const context = createReflectionFlowContext(init);
  context.setActiveRun(storageKey);
  return context;
}
