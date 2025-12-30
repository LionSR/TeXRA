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

import type { RoundOutput } from '@agent/output';
import type { AgentLogStage } from '@logger/AgentLogger';
import type { StorageKey } from '@agent/types/IdentifierTypes';
import type { AgentRoundFinalizedCallback } from '@agent/core/AgentSharedStore';

import {
  AgentWorkspaceState,
  type AgentWorkspaceSnapshot,
} from '@agent/core/AgentWorkspaceState';
import { createRetryState } from '@agent/core/flows/RetryState';
import { PersistedFlow, type FlowRecord } from '@agent/node/persisted-flow';
import { getExecutionStore, type ExecutionKVStore } from '@agent/storage';
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';

import {
  createReflectionFlow,
  type ReflectionFlowShared,
} from './ReflectionFlow';
import { createInitialReflectionState } from './ReflectionFlowState';
import {
  createReadyReflectionContext,
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
  getUsageRecorder?: () => AgentRoundFinalizedCallback;

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

  const storageKey = executionContext.storageKey;

  // Create ready-to-use flow context (handles setActiveRun)
  const flowContext = createReadyReflectionContext(
    {
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
    },
    storageKey,
  );

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
  let shared: ReflectionFlowShared | undefined;
  let createdRunStage = false;

  try {
    // Register context for interrupt handling
    callbacks?.onContextReady?.(storageKey, flowContext);

    // Create or use provided run stage
    const runStage =
      parentStage ??
      (await executionContext.logger.stage(`Run: ${config.agent}`, {
        skip: false,
      }));

    // Track if we created the stage internally
    createdRunStage = !parentStage;

    // Always start from round 0, even on resume.
    // Completed rounds are "replayed" via initializeOutputAndPrefill()
    // which reads existing output files instead of calling the model.
    const roundStage = await executionContext.logger.stage('r0', {
      parent: runStage,
    });

    // Get execution-scoped storage for persistence
    const kv: ExecutionKVStore = getExecutionStore(
      executionContext.executionId,
    );

    // Try to restore workspace snapshot from persisted flow (resume scenario)
    let initialWorkspaceSnapshot: AgentWorkspaceSnapshot;
    let isResume = false;

    try {
      const flowRecord = await kv.read<FlowRecord>(
        `flow:${executionContext.executionId}`,
      );
      if (flowRecord?.shared) {
        const persistedShared = flowRecord.shared as {
          state?: { workspaceSnapshot?: unknown };
        };
        if (persistedShared.state?.workspaceSnapshot) {
          // Restore workspace state from persisted snapshot - PRESERVES THINKING BLOCKS!
          initialWorkspaceSnapshot = AgentWorkspaceState.fromSnapshot(
            persistedShared.state.workspaceSnapshot,
          ).toSnapshot();
          isResume = true;
          executionContext.logger.debug(
            'Restored workspace snapshot from persisted flow',
          );
        } else {
          initialWorkspaceSnapshot = AgentWorkspaceState.create().toSnapshot();
        }
      } else {
        initialWorkspaceSnapshot = AgentWorkspaceState.create().toSnapshot();
      }
    } catch {
      // No persisted flow - fresh start
      initialWorkspaceSnapshot = AgentWorkspaceState.create().toSnapshot();
    }

    // Create shared state for the flow (natively serializable)
    shared = {
      state: createInitialReflectionState(
        flowContext.totalRounds,
        initialWorkspaceSnapshot,
      ),
      retryState: createRetryState(),
    };

    // Set initial round stage
    shared.state.roundStage = roundStage;

    // Create PersistedFlow with the start node
    const startNode = createReflectionFlow<C>().start;
    const pf = new PersistedFlow<
      ReflectionFlowShared,
      Record<string, unknown>,
      ReflectionServices<C>
    >(startNode, kv);

    // Inject services with runStage (never persisted - runtime dependencies)
    pf.setServices({
      ...flowContext.services,
      runStage,
    });

    if (isResume) {
      executionContext.logger.debug(
        'Resuming reflection flow from persistence',
      );
    }

    // Run the persisted flow - errors throw directly
    await pf.run(shared);

    status = END_GROUP_STATUS.STOPPED;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Finalize round stage
    shared?.state.roundStage?.end(status);

    // Finalize run stage if we created it internally
    if (createdRunStage) {
      // Get runStage from services since it's no longer in shared
      const runStage = (flowContext.services as ReflectionServices<C> & { runStage?: AgentLogStage }).runStage;
      runStage?.end(status);
    }

    // Clean up context resources
    flowContext.dispose();

    // Unregister from interrupt registry
    callbacks?.onFlowComplete?.(storageKey);
  }

  return {
    roundOutputs: shared?.state.roundOutputs ?? [],
    status,
  };
}
