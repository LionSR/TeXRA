/**
 * runToolUseFlow - Entry point for tool-use flow execution.
 *
 * Executes interactive tool-use sessions where the agent can call tools
 * and wait for user follow-up messages. The flow manages:
 * - Session lifecycle (start, persist, resume)
 * - Tool execution cycles
 * - Interrupt handling and cleanup
 * - State persistence via PersistedFlow
 */

import { EXECUTION_STATUS } from '@shared/schemas';
import { END_GROUP_STATUS, type EndGroupStatus } from '@shared/schemas';
import { getExecutionStore, type ExecutionKVStore } from '@agent/storage';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';

import { PersistedFlow, type FlowRecord } from '@agent/node/persisted-flow';
import { executionToEndStatus } from '@common/constants/streamStatus';

import { getDefaultToolRegistry } from '@tools/registry';
import { createToolUseRunFlow, type ToolUseRunShared } from '../ToolUseRunFlow';
import {
  resolveTools,
  type ToolUseFlowContextInit,
} from './ToolUseFlowContext';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import { migrateSharedState } from './nodes';
import type { StreamTabId } from '@shared/schemas';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';
import type { ToolUseServices } from './ToolUseServices';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for running a tool-use flow.
 */
export interface RunToolUseFlowInput<C = unknown> extends Omit<
  ToolUseFlowContextInit<C>,
  'resumeSnapshot'
> {
  /**
   * Optional: Resume snapshot for session recovery.
   */
  resumeSnapshot?: ToolUseSessionSnapshot | null;
}

/**
 * Result from running a tool-use flow.
 */
export interface RunToolUseFlowResult {
  /** Status of the flow execution */
  status: EndGroupStatus;
}

/** Runtime context for tool-use flow execution (created inline, not via factory). */
export interface ToolUseFlowContext<C = unknown> {
  services: ToolUseServices<C>;
  session: ToolUseSessionLifecycle;
  interrupt(): void;
  dispose(): void;
}

/**
 * Optional setup callback for tool-use flow.
 *
 * Called after the flow context is created but before execution starts.
 * Use this to configure the session (e.g., append follow-up messages for resume).
 *
 * Note: Interrupt registration/unregistration is handled automatically by the
 * flow runner - callers don't need to manage this.
 */
export type ToolUseFlowSetupCallback = (
  context: ToolUseFlowContext<unknown>,
) => void;

// ============================================================================
// Flow Runner
// ============================================================================

/**
 * Run a tool-use flow.
 *
 * Interrupt registration is handled automatically - the flow context is
 * registered when created and unregistered on completion/error.
 *
 * @param input - Flow configuration and dependencies
 * @param onSetup - Optional callback to configure context before execution
 * @returns Flow execution result
 */
export async function runToolUseFlow<C = unknown>(
  input: RunToolUseFlowInput<C>,
  onSetup?: ToolUseFlowSetupCallback,
): Promise<RunToolUseFlowResult> {
  const { logger, streamId, executionId, setting, onInterrupt } = input;
  const resumeSnapshot = input.resumeSnapshot ?? null;

  // Create session lifecycle and resolve tools inline (no factory indirection)
  const sessionLifecycle = new ToolUseSessionLifecycle(streamId);
  const toolRegistry = input.toolRegistry ?? getDefaultToolRegistry();
  const resolvedTools = resolveTools(setting.tools, toolRegistry, logger);
  const services: ToolUseServices<C> = {
    ...input,
    toolRegistry,
    session: sessionLifecycle,
    resolvedTools,
    snapshot: resumeSnapshot,
    getUsageRecorder: input.getUsageRecorder ?? (() => async () => {}),
  };

  const flowContext: ToolUseFlowContext<C> = {
    services,
    session: sessionLifecycle,
    interrupt(): void {
      onInterrupt?.();
      retryCoordinator.clearRequest(streamId);
      sessionLifecycle.interrupt();
    },
    dispose(): void {
      sessionLifecycle.dispose();
    },
  };

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;

  try {
    // Register for interrupt handling (inside try to ensure finally runs)
    registerInterruptible(streamId, flowContext);

    // Allow caller to configure context (e.g., append follow-ups for resume)
    onSetup?.(flowContext as ToolUseFlowContext<unknown>);

    // Get execution-scoped storage for persistence
    const kv: ExecutionKVStore = getExecutionStore(executionId);

    // Check for persisted flow (resume scenario)
    let flowRecord: FlowRecord | null = null;
    try {
      flowRecord = (await kv.read<FlowRecord>(`flow:${executionId}`)) ?? null;
    } catch (error) {
      logger.debug(
        `Resume parse failed, starting fresh: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    let isResume = Boolean(flowRecord?.shared);
    if (isResume) {
      logger.debug('Resuming tool-use flow from persistence');

      // Migrate legacy shared state format if needed.
      // Pre-flattening sessions stored shared as { state: { conversation, ... } }
      // which would cause failures when cycle node reads shared.stateSlices.
      const migrationResult = migrateSharedState(flowRecord!.shared);
      if (migrationResult === null) {
        // Corrupted/unparseable state - delete and start fresh
        logger.warn('Failed to parse flow record shared state, starting fresh');
        await kv.delete(`flow:${executionId}`);
        flowRecord = null;
        isResume = false;
      } else if (migrationResult.migrated) {
        logger.debug('Migrated legacy shared state to flat format');
        flowRecord!.shared = migrationResult.data;
        // Persist the migrated format so future resumes use the new structure
        await kv.write(`flow:${executionId}`, flowRecord);
      }
    }

    // Create shared state (flat structure for consistency with reflection flows)
    const shared: ToolUseRunShared = {
      conversation: [],
      shouldSkipCycle: false,
      stateSlices: null,
    };

    // Create PersistedFlow with the start node
    const startNode = createToolUseRunFlow<C>().start;
    const pf = new PersistedFlow<
      ToolUseRunShared,
      Record<string, unknown>,
      ToolUseServices<C>
    >(startNode, kv);

    // Inject services (never persisted - runtime dependencies)
    pf.setServices(flowContext.services);

    if (flowRecord?.shared) {
      logger.debug('PersistedFlow will resume from last node');
    }

    // Run the persisted flow - errors throw directly
    await pf.run(shared);

    // Determine ExecutionStatus and map to EndGroupStatus
    // Interrupted means user stopped early → show red in UI
    const executionStatus = input.checkInterruption()
      ? EXECUTION_STATUS.INTERRUPTED
      : EXECUTION_STATUS.COMPLETED;
    status = executionToEndStatus(executionStatus) as EndGroupStatus;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Clean up flow record on completion - but preserve if user cancelled retry
    // so they can resume from the last successful breakpoint.
    // When VS Code reloads mid-execution, this block never runs, preserving
    // the record for sessions that were genuinely interrupted mid-wait.
    try {
      const kv = getExecutionStore(executionId);
      const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);
      // Handle both legacy { state: { userCancelledRetry } } and new flat format
      const migrationResult = flowRecord?.shared
        ? migrateSharedState(flowRecord.shared)
        : null;
      const userCancelledRetry =
        migrationResult?.data?.userCancelledRetry === true;

      if (userCancelledRetry) {
        // Preserve flow record for resume - user can continue from last successful breakpoint
        logger.debug(
          'Flow record preserved after retry cancellation for resume capability',
        );
      } else {
        await kv.delete(`flow:${executionId}`);
      }
    } catch {
      // Ignore cleanup errors - non-critical
    }

    // Cleanup (PersistedFlow handles state cleanup automatically)
    flowContext.dispose();

    // Unregister from interrupt handling (moved from executeAgent callbacks)
    unregisterInterruptible(streamId);
  }

  return { status };
}
