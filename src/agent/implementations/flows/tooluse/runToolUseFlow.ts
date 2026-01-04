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

import { getExecutionStore, type ExecutionKVStore } from '@agent/storage';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import {
  registerInterruptible,
  unregisterInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';

import { PersistedFlow, type FlowRecord } from '@agent/node/persisted-flow';
import {
  EXECUTION_STATUS,
  executionToEndStatus,
} from '@common/constants/streamStatus';
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';

import {
  createToolUseRunFlow,
  createInitialToolUseState,
  type ToolUseRunShared,
} from '../ToolUseRunFlow';
import {
  createToolUseFlowContext,
  type ToolUseFlowContext,
  type ToolUseFlowContextInit,
} from './ToolUseFlowContext';
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
  const { logger, streamId, executionId } = input;

  // Create the flow context (owns all services including session lifecycle)
  const flowContext = createToolUseFlowContext<C>({
    ...input,
    resumeSnapshot: input.resumeSnapshot ?? null,
  });
  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;

  try {
    // Register for interrupt handling (inside try to ensure finally runs)
    registerInterruptible(streamId, flowContext);

    // Allow caller to configure context (e.g., append follow-ups for resume)
    onSetup?.(flowContext as ToolUseFlowContext<unknown>);

    // Get execution-scoped storage for persistence
    const kv: ExecutionKVStore = getExecutionStore(
      executionId,
    );

    // Try to restore from persisted flow (resume scenario)
    let isResume = false;
    try {
      const flowRecord = await kv.read<FlowRecord>(
        `flow:${executionId}`,
      );
      if (flowRecord?.shared) {
        isResume = true;
        logger.debug(
          'Resuming tool-use flow from persistence',
        );
      }
    } catch {
      // No persisted flow - fresh start
    }

    // Create shared state
    const shared: ToolUseRunShared = {
      state: createInitialToolUseState(),
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

    if (isResume) {
      logger.debug(
        'PersistedFlow will resume from last node',
      );
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
    // Clean up flow record on completion.
    // When VS Code reloads mid-execution, this block never runs, preserving
    // the record for sessions that were genuinely interrupted mid-wait.
    try {
      const kv = getExecutionStore(executionId);
      await kv.delete(`flow:${executionId}`);
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
