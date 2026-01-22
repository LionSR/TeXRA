/**
 * runReflectionFlow - Entry point for reflection flow execution.
 *
 * Executes workflow-style agents that run for a fixed number of rounds,
 * producing structured output. Behavior is configuration-driven:
 * - Total rounds = max(setting.rounds, userRequest.length)
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

import * as path from 'path';

import type { RoundOutput, IOutputHandler } from '@agent/output';
import { OutputHandler } from '@agent/output';
import { getExecutionStore, type ExecutionKVStore } from '@agent/storage';
import type {
  StreamTabId,
  StorageKeyManager,
} from '@agent/types/IdentifierTypes';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';
import {
  registerInterruptible,
  unregisterInterruptible,
  type IInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { getOutputFileName } from '@agent/utils/outputFileUtils';

import { AgentRunState } from '@agent/core/AgentState';
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
import {
  TaskRunFileService,
  WorkspaceFS,
  createWorkspaceLocation,
  type AgentFileLocation,
  type WorkspaceFileLocation,
} from '@utils/files';
import { LatexMediaManager } from '@latex';

import {
  createReflectionFlow,
  type ReflectionFlowShared,
} from './ReflectionFlow';
import { ReflectionFlowStateSchema } from './ReflectionFlowState';
import type { ReflectionServices } from './ReflectionServices';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for running a reflection flow.
 * Extends BaseFlowContextInit with reflection-specific fields and StorageKeyManager.
 */
export interface RunReflectionFlowInput<C = unknown>
  extends BaseFlowContextInit<C>, StorageKeyManager {
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
// Configuration Derivation
// ============================================================================

interface DerivedConfig {
  useScratchpad: boolean;
  shouldEnsureXmlStructure: boolean;
  totalRounds: number;
  outputExt: string;
}

/** Determine if XML structure enforcement is needed based on settings and scratchpad usage. */
function shouldEnforceXmlStructure(
  setting: AgentWorkflowSetting,
  useScratchpad: boolean,
): boolean {
  const mode = setting.xmlStructureMode ?? 'scratchpadOnly';

  switch (mode) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'scratchpadOnly':
      return useScratchpad;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown xmlStructureMode: ${_exhaustive}`);
    }
  }
}

/** Compute the total number of rounds: max(setting.rounds, userRequest.length) */
function computeTotalRounds(
  setting: AgentWorkflowSetting,
  prompt: RunReflectionFlowInput['prompt'],
): number {
  let requests: string[];
  if (Array.isArray(prompt.userRequest)) {
    requests = prompt.userRequest;
  } else if (prompt.userRequest) {
    requests = [prompt.userRequest];
  } else {
    requests = [];
  }

  return Math.max(setting.rounds ?? 2, requests.length);
}

/** Derive configuration values from settings and prompts. */
function deriveConfig(
  setting: AgentWorkflowSetting,
  prompt: RunReflectionFlowInput['prompt'],
): DerivedConfig {
  const useScratchpad = setting.prefills?.includes('<scratchpad>') ?? false;

  return {
    useScratchpad,
    shouldEnsureXmlStructure: shouldEnforceXmlStructure(setting, useScratchpad),
    totalRounds: computeTotalRounds(setting, prompt),
    outputExt: useScratchpad ? 'xml' : setting.outputExt,
  };
}

// ============================================================================
// Flow Runner
// ============================================================================

/** Run a reflection flow. Creates services and manages interrupt registration. */
export async function runReflectionFlow<C = unknown>(
  input: RunReflectionFlowInput<C>,
): Promise<RunReflectionFlowResult> {
  const {
    modelHandler,
    config,
    setting,
    prompt,
    logger,
    streamId,
    executionId,
    getStorageKey,
    hasInitialStorageKey,
    updateStorageKey,
    userVarChannels,
    checkInterruption,
    setAbortController,
    getUsageRecorder = () => async () => {},
    parentStage,
  } = input;

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
  let shared: ReflectionFlowShared | undefined;
  let services: ReflectionServices<C> | undefined;
  let createdRunStage = false;

  // ========================================================================
  // Create services inline (previously in createReflectionFlowContext)
  // ========================================================================

  const fileService = new TaskRunFileService(executionId);

  // Create workspace file locations for latexdiff base files
  const baseFiles: WorkspaceFileLocation[] = (
    config.outputFiles.length > 0 ? config.outputFiles : [config.inputFile]
  ).map((f) => {
    const absolutePath = path.isAbsolute(f) ? f : WorkspaceFS.fullPath(f);
    const relativePath = path.isAbsolute(f) ? WorkspaceFS.relativePath(f) : f;
    return createWorkspaceLocation(absolutePath, relativePath);
  });

  const outputHandler: IOutputHandler = new OutputHandler(
    setting,
    config,
    baseFiles,
    logger,
    fileService,
    executionId,
  );

  const promptBuilder = new PromptBuilder(
    prompt,
    setting,
    userVarChannels.transient,
    logger,
  );

  const latexMediaManager = new LatexMediaManager(logger, fileService);

  // Derive configuration values
  const { useScratchpad, shouldEnsureXmlStructure, totalRounds, outputExt } =
    deriveConfig(setting, prompt);

  // Create output file location getter
  const modelName = modelHandler.config.name;
  const getOutputFileLocation =
    input.getOutputFileLocation ??
    ((round: number): AgentFileLocation => {
      const fileName = getOutputFileName(
        config.inputFile,
        config.agent,
        modelName,
        outputExt,
        round,
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
      retryCoordinator.clearRequest(streamId);
    },
  };

  // ========================================================================
  // Run stage and storage key setup
  // ========================================================================

  // Create or use provided run stage FIRST - we need its ID for storage key
  const runStage =
    parentStage ??
    (await logger.stage(`Run: ${config.agent}`, {
      skip: false,
    }));

  createdRunStage = !parentStage;

  // For new runs, update storage key to match the run stage ID
  // Note: runStage.id is always defined for newly created stages
  if (createdRunStage && hasInitialStorageKey()) {
    const runStorageKey = normalizeRunId(runStage.id!);
    updateStorageKey(runStorageKey);
  }

  const storageKey = getStorageKey();

  // Set active run for output handler
  outputHandler.setActiveRun(storageKey);

  try {
    // Register for interrupt handling
    registerInterruptible(streamId, interruptible);

    // Get execution-scoped storage for persistence
    const kv: ExecutionKVStore = getExecutionStore(executionId);

    // Try to restore full state from persisted flow (resume scenario)
    let isResume = false;

    try {
      const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);
      if (flowRecord?.shared) {
        // Validate and use persisted shared state directly
        const validated = ReflectionFlowStateSchema.safeParse(
          flowRecord.shared,
        );
        if (validated.success) {
          shared = validated.data as ReflectionFlowShared;
          isResume = true;
          logger.debug(
            `Resuming reflection flow from round ${shared.currentRound}/${shared.totalRounds}`,
          );
        }
      }
    } catch (error) {
      // Log parse failures to help diagnose resume issues
      logger.debug(
        `Resume parse failed, starting fresh: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    // Create fresh state if not resuming
    if (!shared) {
      shared = {
        currentRound: 0,
        totalRounds,
        workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
        context: null,
        outputLocation: null,
        conversation: [],
        runStateSnapshot: new AgentRunState().toSnapshot(),
        roundStateSnapshots: [],
        roundOutputs: [],
        continueRounds: true,
        endTurn: false,
      };
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
          return await logger.stage(`r${roundIndex}`, {
            parent: parent ?? undefined,
          });
        },
        resetForNextRound: (s) => {
          s.workspaceSnapshot = AgentWorkspaceState.create().toSnapshot();
        },
        checkInterruption,
        onFlowEnd: (_shared, flowEndStatus) => {
          flowResult.status = flowEndStatus;
        },
      },
    });

    // Build services: spread input + add computed fields
    services = {
      ...input,
      getUsageRecorder,
      outputHandler,
      latexMediaManager,
      promptBuilder,
      fileService,
      getOutputFileLocation,
      shouldEnsureXmlStructure,
      runStage,
      baseFiles,
    };
    pf.setServices(services);

    if (isResume) {
      logger.debug('Resuming reflection flow from persistence');
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
        const kv = getExecutionStore(executionId);
        await kv.delete(`flow:${executionId}`);
      } catch {
        // Ignore cleanup errors
      }
    }

    if (createdRunStage) {
      (services?.runStage ?? runStage)?.end(status);
    }

    // Clean up retry coordinator
    retryCoordinator.clearRequest(streamId);

    unregisterInterruptible(streamId);
  }

  return {
    roundOutputs: shared?.roundOutputs ?? [],
    status,
  };
}
