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
 * ## Live State with Serialization Hooks
 *
 * Shared state contains class instances (AgentWorkspaceState, AgentRunState)
 * that nodes can mutate directly. Serialization to/from JSON happens ONLY
 * at persistence boundaries via reflectionFlowSerializationHooks.
 *
 * This eliminates the reconstruct-mutate-update pattern that was previously
 * required in every node.
 */

import type { RoundOutput } from '@agent/output';
import { getExecutionStore, type ExecutionKVStore } from '@agent/storage';
import type { StorageKey } from '@agent/types/IdentifierTypes';
import type { RoundFinalizedCallback } from '@agent/core/flows/CycleServices';

import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { RetryErrorInfo } from '@agent/core/flows/RetryState';
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

import {
  createReflectionFlow,
  type ReflectionFlowShared,
} from './ReflectionFlow';
import {
  createFreshWorkspace,
  createInitialReflectionState,
  reflectionFlowSerializationHooks,
} from './ReflectionFlowState';
import {
  createReflectionFlowContext,
  ReflectionFlowContext,
  type ReflectionFlowContextInit,
} from './ReflectionFlowContext';
import type { ReflectionServices } from './ReflectionServices';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for running a reflection flow.
 */
export interface RunReflectionFlowInput<C = unknown> extends Omit<
  ReflectionFlowContextInit<C>,
  'getUsageRecorder'
> {
  /**
   * Usage recorder callback. If not provided, usage is not tracked.
   */
  getUsageRecorder?: () => RoundFinalizedCallback;

  /**
   * Optional: Parent log stage for creating round stages.
   * If not provided, a new stage will be created.
   */
  parentStage?: AgentLogStage;
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

/**
 * Callbacks for reflection flow lifecycle events.
 * Mirrors the pattern from runToolUseFlow for consistency.
 */
export interface RunReflectionFlowCallbacks {
  /**
   * Called when the flow context is ready for registration.
   * Use this to register the context with the interrupt registry.
   */
  onContextReady?: (
    storageKey: StorageKey,
    context: ReflectionFlowContext<unknown>,
  ) => void;

  /**
   * Called when the flow completes (success or error).
   * Use this to unregister from the interrupt registry.
   */
  onFlowComplete?: (storageKey: StorageKey) => void;
}

// ============================================================================
// Flow Runner
// ============================================================================

/**
 * Run a reflection flow.
 *
 * @param input - Flow configuration and dependencies
 * @param callbacks - Optional lifecycle callbacks for interrupt registration
 * @returns Flow execution result
 */
export async function runReflectionFlow<C = unknown>(
  input: RunReflectionFlowInput<C>,
  callbacks?: RunReflectionFlowCallbacks,
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
    getClient,
    getUsageRecorder = () => async () => {},
    parentStage,
  } = input;

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
  let shared: ReflectionFlowShared | undefined;
  let services: ReflectionServices<C> | undefined;
  let createdRunStage = false;

  // Create or use provided run stage FIRST - we need its ID for storage key
  const runStage =
    parentStage ??
    (await executionContext.logger.stage(`Run: ${config.agent}`, {
      skip: false,
    }));

  // Track if we created the stage internally
  createdRunStage = !parentStage;

  // For new runs, update storage key to match the run stage ID.
  // This ensures output files, usage, and other storage operations use
  // the same key as the task group that the frontend uses for filtering.
  // For resumed runs where a parent stage is provided, we trust the existing
  // storage key since the parent stage ID should already match.
  if (
    createdRunStage &&
    runStage.id &&
    executionContext.hasInitialStorageKey()
  ) {
    const runStorageKey = normalizeRunId(runStage.id);
    executionContext.updateStorageKey(runStorageKey);
  }

  const storageKey = executionContext.storageKey;

  // Create flow context and set active run for output handler
  const flowContext = createReflectionFlowContext({
    modelHandler,
    config,
    setting,
    prompt,
    executionContext,
    userVarChannels,
    checkInterruption,
    setAbortController,
    getClient,
    getUsageRecorder,
  });
  flowContext.setActiveRun(storageKey);

  try {
    // Register context for interrupt handling
    callbacks?.onContextReady?.(storageKey, flowContext);

    // Get execution-scoped storage for persistence
    const kv: ExecutionKVStore = getExecutionStore(
      executionContext.executionId,
    );

    // Try to restore state from persisted flow (resume scenario)
    // Note: The serialization hooks handle conversion from snapshots to instances
    let initialWorkspace: AgentWorkspaceState | undefined;
    let restoredRetryError: RetryErrorInfo | undefined;
    let isResume = false;

    try {
      const flowRecord = await kv.read<FlowRecord>(
        `flow:${executionContext.executionId}`,
      );
      if (flowRecord?.shared) {
        const persistedShared = flowRecord.shared as {
          workspaceSnapshot?: unknown;
          lastRetryError?: RetryErrorInfo;
        };
        if (persistedShared.workspaceSnapshot) {
          // Restore workspace instance from persisted snapshot
          initialWorkspace = AgentWorkspaceState.fromSnapshot(
            persistedShared.workspaceSnapshot,
          );
          isResume = true;
          executionContext.logger.debug('Restored workspace from persisted flow');
        }
        if (persistedShared.lastRetryError) {
          restoredRetryError = persistedShared.lastRetryError;
          executionContext.logger.debug(
            `Restored lastRetryError: ${restoredRetryError.message}`,
          );
        }
      }
    } catch {
      // No persisted flow - fresh start
    }

    // Create shared state with live instances (serialization hooks handle persistence)
    shared = createInitialReflectionState(flowContext.totalRounds, initialWorkspace);
    if (restoredRetryError) {
      shared.lastRetryError = restoredRetryError;
    }

    // Create RoundPersistedFlow with the start node
    // Round stage management is now handled by the flow, not by nodes
    const startNode = createReflectionFlow<C>().start;
    // Track flow completion status from onFlowEnd hook
    // Use object wrapper to avoid TypeScript narrowing issues with closure mutation
    const flowResult = {
      status: EXECUTION_STATUS.COMPLETED as ExecutionStatus,
    };
    const pf = new RoundPersistedFlow<
      ReflectionFlowShared,
      Record<string, unknown>,
      ReflectionServices<C>
    >(startNode, kv, {
      parentStage: runStage,
      // Serialization hooks convert live instances ↔ snapshots at persistence boundaries
      serialization: reflectionFlowSerializationHooks,
      hooks: {
        createRoundStage: async (roundIndex, parent) => {
          return await executionContext.logger.stage(`r${roundIndex}`, {
            parent: parent ?? undefined,
          });
        },
        // Reset workspace instance for new round
        resetForNextRound: (s) => {
          s.workspace = createFreshWorkspace();
        },
        checkInterruption,
        onFlowEnd: (_shared, flowEndStatus) => {
          flowResult.status = flowEndStatus;
        },
      },
    });

    // Build services - round stages are managed by RoundPersistedFlow
    // Keep reference to services for finally block access
    services = {
      ...flowContext.services,
      runStage,
    };
    pf.setServices(services);

    if (isResume) {
      executionContext.logger.debug(
        'Resuming reflection flow from persistence',
      );
    }

    // Run the persisted flow - errors throw directly
    // RoundPersistedFlow automatically manages round stages
    await pf.run(shared);

    // Get final shared state with all mutations (including roundOutputs)
    shared = await pf.getShared();

    // Map ExecutionStatus to EndGroupStatus using transformation function
    status = executionToEndStatus(flowResult.status) as EndGroupStatus;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Round stages are finalized by RoundPersistedFlow - no need to end them here

    // Finalize run stage if we created it internally.
    // Prefer services.runStage (may have been updated) but fall back to runStage
    // if services wasn't assigned (error before services creation).
    if (createdRunStage) {
      (services?.runStage ?? runStage)?.end(status);
    }

    // Clean up context resources (defensive check in case of early failure)
    flowContext?.dispose();

    // Unregister from interrupt registry
    callbacks?.onFlowComplete?.(storageKey);
  }

  return {
    roundOutputs: shared?.roundOutputs ?? [],
    status,
  };
}
