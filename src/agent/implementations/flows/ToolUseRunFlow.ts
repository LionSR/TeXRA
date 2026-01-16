/**
 * ToolUseRunFlow - PocketFlow implementation for tool-use agents.
 *
 * Flow: prepare → cycle → wait (loop back via CONTINUE)
 * Services injected via flow.setServices(), accessed via this.services.
 *
 * Node implementations are in ./tooluse/nodes/:
 * - ToolUsePrepareNode: Initializes session state
 * - ToolUseCycleNode: Runs tool-use cycles
 * - ToolUseWaitNode: Waits for follow-up messages
 */
import { Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

import { type ToolUseServices, type ToolUseFlowParams } from './tooluse';
import {
  ToolUsePrepareNode,
  ToolUseCycleNode,
  ToolUseWaitNode,
  type ToolUseRunShared,
} from './tooluse/nodes';

// Re-export types for consumers
export type { ToolUseRunShared };

/**
 * Creates a tool-use flow: prepare → cycle → wait (loop via CONTINUE).
 *
 * The flow structure is:
 * 1. ToolUsePrepareNode: Initialize or resume session state
 * 2. ToolUseCycleNode: Run model + tool cycles
 * 3. ToolUseWaitNode: Wait for follow-up, then loop back to cycle
 */
export function createToolUseRunFlow<C = unknown>(): Flow<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  const prepareNode = new ToolUsePrepareNode<C>();
  const cycleNode = new ToolUseCycleNode<C>();
  const waitNode = new ToolUseWaitNode<C>();

  prepareNode.next(cycleNode);
  cycleNode.next(waitNode);
  waitNode.on(FlowTransition.CONTINUE, cycleNode);

  return new Flow<ToolUseRunShared, ToolUseFlowParams, ToolUseServices<C>>(
    prepareNode,
  );
}
