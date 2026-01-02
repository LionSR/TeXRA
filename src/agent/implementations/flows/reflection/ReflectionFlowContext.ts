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
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import type { StorageKey } from '@agent/types/IdentifierTypes';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import type { IInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import type { AgentFileLocation } from '@utils/files';

import { PromptBuilder } from '@utils/prompt';
import { TaskRunFileService } from '@utils/files';
import { LatexMediaManager } from '@latex';
import { createBaseFileLocations } from './helpers';
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
  getUsageRecorder: () => RoundFinalizedCallback;

  /**
   * Optional custom output file location getter.
   * When provided, overrides the default file naming logic.
   * Used by merge operations which have specialized naming conventions.
   */
  getOutputFileLocation?: (round: number) => AgentFileLocation;
}

// ============================================================================
// Context Object (simple object, not a class)
// ============================================================================

/**
 * Reflection flow context returned by factory function.
 * Contains services and lifecycle methods.
 *
 * Extends IInterruptible to allow registration with the interrupt registry.
 */
export interface ReflectionFlowContext<C = unknown> extends IInterruptible {
  /** Services for flow execution (missing runStage - set by runReflectionFlow) */
  services: ReflectionServicesPartial<C>;

  /** Total number of rounds to execute */
  totalRounds: number;

  /** Set the active run storage key on the output handler */
  setActiveRun(storageKey: StorageKey): void;

  /** Dispose context resources */
  dispose(): void;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a ReflectionFlowContext with all services and behaviors configured.
 *
 * This is the primary entry point for setting up flow execution.
 * Returns a simple object with services and lifecycle methods.
 *
 * Note: Returns partial services (missing runStage). The runStage is added
 * by runReflectionFlow after the run stage is created/provided.
 */
export function createReflectionFlowContext<C = unknown>(
  init: ReflectionFlowContextInit<C>,
): ReflectionFlowContext<C> {
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

  // Compute shouldEnsureXmlStructure from configuration
  // Priority: xmlStructureMode > agentType > default (false)
  const useScratchpad = setting.prefills?.includes('<scratchpad>') ?? false;
  let shouldEnsureXmlStructure = false;
  if (setting.xmlStructureMode !== undefined) {
    shouldEnsureXmlStructure =
      setting.xmlStructureMode === 'always' ||
      (setting.xmlStructureMode === 'scratchpadOnly' && useScratchpad);
  } else if (setting.agentType === 'CoT') {
    shouldEnsureXmlStructure = true;
  } else if (setting.agentType === 'direct') {
    shouldEnsureXmlStructure = useScratchpad;
  }

  // Compute totalRounds from configuration
  // Priority: maxRounds > agentType=direct (1) > max(rounds, userRequest length)
  let totalRounds: number;
  if (setting.maxRounds !== undefined) {
    totalRounds = setting.maxRounds;
  } else if (setting.agentType === 'direct') {
    totalRounds = 1;
  } else {
    const requestArray = Array.isArray(prompt.userRequest)
      ? prompt.userRequest
      : prompt.userRequest
        ? [prompt.userRequest]
        : [];
    totalRounds = Math.max(setting.rounds ?? 2, requestArray.length);
  }

  // Use custom getter if provided, otherwise create default output file location getter
  const getOutputFileLocation =
    init.getOutputFileLocation ??
    ((currRound: number): AgentFileLocation => {
      const fileExtension = useScratchpad ? 'xml' : setting.outputExt;
      const fileName = getOutputFileName(
        config.inputFile,
        config.agent,
        modelHandler.config.name,
        fileExtension,
        currRound,
        config.editedFile || undefined,
      );
      return (
        useScratchpad
          ? fileService.createRawOutputLocation(fileName)
          : fileService.createLocation(fileName)
      ) as AgentFileLocation;
    });

  // Build partial services (missing runStage - added by runReflectionFlow)
  const services: ReflectionServicesPartial<C> = {
    ...init,
    logger: executionContext.logger,
    context: executionContext,
    setting,
    outputHandler,
    latexMediaManager,
    promptBuilder,
    fileService,
    getOutputFileLocation,
    shouldEnsureXmlStructure,
    getUsageRecorder,
  };

  return {
    services,
    totalRounds,

    setActiveRun(storageKey: StorageKey): void {
      outputHandler.setActiveRun(storageKey);
    },

    interrupt(): void {
      init.onInterrupt?.();
      retryCoordinator.clearRequest(executionContext.streamId);
    },

    dispose(): void {
      retryCoordinator.clearRequest(executionContext.streamId);
    },
  };
}
