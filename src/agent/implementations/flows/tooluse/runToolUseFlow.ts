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

import { PersistedFlow } from '@agent/node/persisted-flow';
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
 * Callbacks for tool-use flow lifecycle events.
 */
export interface RunToolUseFlowCallbacks {
  /**
   * Called when the flow context is ready, before execution starts.
   * Use this to register the session for interruption handling.
   */
  onContextReady?: (
    streamTabId: StreamTabId,
    context: ToolUseFlowContext<unknown>,
  ) => void;

  /**
   * Called when the flow is complete or failed.
   * Use this to unregister the session.
   */
  onFlowComplete?: (streamTabId: StreamTabId) => void;
}

// ============================================================================
// Flow Runner
// ============================================================================

/**
 * Run a tool-use flow.
 *
 * @param input - Flow configuration and dependencies
 * @param callbacks - Optional lifecycle callbacks for registration
 * @returns Flow execution result
 */
export async function runToolUseFlow<C = unknown>(
  input: RunToolUseFlowInput<C>,
  callbacks?: RunToolUseFlowCallbacks,
): Promise<RunToolUseFlowResult> {
  // Create the flow context (owns all services including session lifecycle)
  const flowContext = createToolUseFlowContext<C>({
    ...input,
    resumeSnapshot: input.resumeSnapshot ?? null,
  });

  const streamTabId = flowContext.streamTabId;

  // Notify that context is ready (for agent registry if needed)
  callbacks?.onContextReady?.(
    streamTabId,
    flowContext as ToolUseFlowContext<unknown>,
  );

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;

  try {
    // Get execution-scoped storage for persistence
    const kv: ExecutionKVStore = getExecutionStore(
      input.executionContext.executionId,
    );

    // Create shared state - PersistedFlow handles resume automatically
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

    // Run the persisted flow - PersistedFlow handles resume automatically
    // via FlowRecord when a prior run exists
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
    // Cleanup (PersistedFlow handles state cleanup automatically)
    flowContext.dispose();

    // Notify completion
    callbacks?.onFlowComplete?.(streamTabId);
  }

  return { status };
}
