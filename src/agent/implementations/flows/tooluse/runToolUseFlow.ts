/**
 * runToolUseFlow - Run tool-use flows without agent class instances.
 *
 * ## Flow-First Architecture
 *
 * This module provides a direct way to run tool-use flows, bypassing the
 * agent class hierarchy entirely. Instead of:
 *
 *   executeAgent → instantiate BaseToolUseAgent → agent.run() → flow.run()
 *
 * We can now do:
 *
 *   runToolUseFlow(config) → flow.run() directly
 *
 * ## What This Replaces:
 *
 * - BaseToolUseAgent class instantiation
 * - BaseToolUseAgent.run() method
 */

import type { ToolUseSessionSnapshot } from '@agent/toolUse/ToolUseSessionManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { END_GROUP_STATUS, type EndGroupStatus } from '@logger/messageTypes';

import {
  createToolUseRunFlow,
  createInitialToolUseState,
  type ToolUseRunShared,
} from '../ToolUseRunFlow';
import {
  ToolUseFlowContext,
  type ToolUseFlowContextInit,
} from './ToolUseFlowContext';

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
 * Run a tool-use flow directly without agent class instances.
 *
 * This is the flow-first replacement for BaseToolUseAgent.run().
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
  const flowContext = new ToolUseFlowContext<C>({
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
    // Create shared state
    const shared: ToolUseRunShared<C> = {
      state: createInitialToolUseState<C>(),
    };

    // Create flow and inject services
    const flow = createToolUseRunFlow<C>();
    flow.setServices(flowContext.services);

    // Run the flow
    await flow.run(shared);

    status = END_GROUP_STATUS.STOPPED;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Cleanup
    await flowContext.session.clearPersistedSnapshot();
    flowContext.dispose();

    // Notify completion
    callbacks?.onFlowComplete?.(streamTabId);
  }

  return { status };
}
