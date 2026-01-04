/**
 * runReflectionFlow - Entry point for reflection flow execution.
 *
 * Executes workflow-style agents that run for a fixed number of rounds,
 * producing structured output. Behavior is configuration-driven:
 * - `setting.maxRounds`: Number of reflection rounds
 * - `setting.xmlStructureMode`: 'never' | 'scratchpadOnly' | 'always'
 *
 * The flow manages:
 * - Round progression and stage lifecycle
 * - Prompt building and output handling
 * - Interrupt handling and cleanup
 *
 * ## Koala-code-reader Pattern
 *
 * Following koala's approach:
 * - shared state is natively serializable (snapshots, not class instances)
 * - services contain runtime dependencies (runStage, logger, etc.)
 * - PersistedFlow handles persistence transparently
 */

import type { RoundOutput, IOutputHandler } from '@agent/output';
import { OutputHandler } from '@agent/output';
import { getExecutionStore, type ExecutionKVStore } from '@agent/storage';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import {
  registerInterruptible,
  unregisterInterruptible,
  type IInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { getOutputFileName } from '@agent/utils/outputFileUtils';

import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { type FlowRecord } from '@agent/node/persisted-flow';
import { RoundPersistedFlow } from '@agent/node/round-persisted-flow';
import { normalizeRunId } from '@common/constants/runIds';
import {
  EXECUTION_STATUS,
  executionToEndStatus,
  type ExecutionStatus,
} from '@common/constants/streamStatus';
import type { AgentLogStage } from '@logger/AgentLogger';
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';
import { PromptBuilder } from '@utils/prompt';
import { TaskRunFileService, type AgentFileLocation } from '@utils/files';
import { LatexMediaManager } from '@latex';

import {
  createReflectionFlow,
  type ReflectionFlowShared,
} from './ReflectionFlow';
import {
  createFreshWorkspaceSnapshot,
  createInitialReflectionState,
  ReflectionFlowStateSchema,
} from './ReflectionFlowState';
import { createBaseFileLocations } from './helpers';
import type { ReflectionServices } from './ReflectionServices';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for running a reflection flow.
 * Extends BaseFlowContextInit with reflection-specific fields.
 */
export interface RunReflectionFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  /** Narrow setting to workflow-specific type */
  setting: AgentWorkflowSetting;

  /** Usage recorder callback. If not provided, usage is not tracked. */
  getUsageRecorder?: () => RoundFinalizedCallback;

  /** Optional: Parent log stage for creating round stages. */
  parentStage?: AgentLogStage;

  /** Optional custom output file location getter (used by merge). */
  getOutputFileLocation?: (round: number) => AgentFileLocation;
}

/**
 * Result from running a reflection flow.
 */
export interface RunReflectionFlowResult {
  /** Round outputs from the flow execution */
  roundOutputs: RoundOutput[];

  /** Status of the flow execution */
  status: EndGroupStatus;
}

// ============================================================================
// Flow Runner
// ============================================================================

/**
 * Run a reflection flow.
 *
 * Creates all services inline and manages interrupt registration.
 *
 * @param input - Flow configuration and dependencies
 * @returns Flow execution result
 */
export async function runReflectionFlow<C = unknown>(
  input: RunReflectionFlowInput<C>,
): Promise<RunReflectionFlowResult> {
  const {
    modelHandler,
    config,
    setting,
    prompt,
    executionContext,
    userVarChannels,
    checkInterruption,
    setAbortController,
    getUsageRecorder = () => async () => {},
    parentStage,
  } = input;

  // Single source of truth: get streamTabId from execution context
  const streamTabId = executionContext.streamId;

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
  let shared: ReflectionFlowShared | undefined;
  let services: ReflectionServices<C> | undefined;
  let createdRunStage = false;

  // ========================================================================
  // Create services inline (previously in createReflectionFlowContext)
  // ========================================================================

  const fileService = new TaskRunFileService(executionContext.executionId);
  const baseFiles = createBaseFileLocations(config);

  const outputHandler: IOutputHandler = new OutputHandler(
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

  // Use custom getter if provided, otherwise create default
  const getOutputFileLocation =
    input.getOutputFileLocation ??
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

  // Create interruptible object for registration
  const interruptible: IInterruptible = {
    interrupt(): void {
      input.onInterrupt?.();
      retryCoordinator.clearRequest(executionContext.streamId);
    },
  };

  // ========================================================================
  // Run stage and storage key setup
  // ========================================================================

  // Create or use provided run stage FIRST - we need its ID for storage key
  const runStage =
    parentStage ??
    (await executionContext.logger.stage(`Run: ${config.agent}`, {
      skip: false,
    }));

  createdRunStage = !parentStage;

  // For new runs, update storage key to match the run stage ID
  if (
    createdRunStage &&
    runStage.id &&
    executionContext.hasInitialStorageKey()
  ) {
    const runStorageKey = normalizeRunId(runStage.id);
    executionContext.updateStorageKey(runStorageKey);
  }

  const storageKey = executionContext.storageKey;

  // Set active run for output handler
  outputHandler.setActiveRun(storageKey);

  try {
    // Register for interrupt handling
    registerInterruptible(streamTabId, interruptible);

    // Get execution-scoped storage for persistence
    const kv: ExecutionKVStore = getExecutionStore(
      executionContext.executionId,
    );

    // Try to restore full state from persisted flow (resume scenario)
    let isResume = false;

    try {
      const flowRecord = await kv.read<FlowRecord>(
        `flow:${executionContext.executionId}`,
      );
      if (flowRecord?.shared) {
        // Validate and use persisted shared state directly
        const validated = ReflectionFlowStateSchema.safeParse(
          flowRecord.shared,
        );
        if (validated.success) {
          shared = validated.data as ReflectionFlowShared;
          isResume = true;
          executionContext.logger.debug(
            `Resuming reflection flow from round ${shared.currentRound}/${shared.totalRounds}`,
          );
        }
      }
    } catch (error) {
      // Log parse failures to help diagnose resume issues
      executionContext.logger.debug(
        `Resume parse failed, starting fresh: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    // Create fresh state if not resuming
    if (!shared) {
      shared = createInitialReflectionState(
        totalRounds,
        AgentWorkspaceState.create().toSnapshot(),
      );
    }

    // Create RoundPersistedFlow with the start node
    const startNode = createReflectionFlow<C>().start;
    const flowResult = {
      status: EXECUTION_STATUS.COMPLETED as ExecutionStatus,
    };
    const pf = new RoundPersistedFlow<
      ReflectionFlowShared,
      Record<string, unknown>,
      ReflectionServices<C>
    >(startNode, kv, {
      parentStage: runStage,
      hooks: {
        createRoundStage: async (roundIndex, parent) => {
          return await executionContext.logger.stage(`r${roundIndex}`, {
            parent: parent ?? undefined,
          });
        },
        resetForNextRound: (s) => {
          s.workspaceSnapshot = createFreshWorkspaceSnapshot();
        },
        checkInterruption,
        onFlowEnd: (_shared, flowEndStatus) => {
          flowResult.status = flowEndStatus;
        },
      },
    });

    // Build services: spread input + add computed fields
    // Note: getUsageRecorder must override input's optional value with the destructured default
    services = {
      ...input,
      logger: executionContext.logger,
      getUsageRecorder,
      outputHandler,
      latexMediaManager,
      promptBuilder,
      fileService,
      getOutputFileLocation,
      shouldEnsureXmlStructure,
      runStage,
    };
    pf.setServices(services);

    if (isResume) {
      executionContext.logger.debug(
        'Resuming reflection flow from persistence',
      );
    }

    await pf.run(shared);
    shared = await pf.getShared();
    status = executionToEndStatus(flowResult.status) as EndGroupStatus;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Only delete flow record on successful completion
    // Keep it for interrupted/error flows to enable resume
    // Note: END_GROUP_STATUS.STOPPED means "completed" (not user-stopped)
    if (status === END_GROUP_STATUS.STOPPED) {
      try {
        const kv = getExecutionStore(executionContext.executionId);
        await kv.delete(`flow:${executionContext.executionId}`);
      } catch {
        // Ignore cleanup errors
      }
    }

    if (createdRunStage) {
      (services?.runStage ?? runStage)?.end(status);
    }

    // Clean up retry coordinator
    retryCoordinator.clearRequest(executionContext.streamId);

    unregisterInterruptible(streamTabId);
  }

  return {
    roundOutputs: shared?.roundOutputs ?? [],
    status,
  };
}
