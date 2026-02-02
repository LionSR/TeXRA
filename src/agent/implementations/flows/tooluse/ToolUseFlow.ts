/**
 * ToolUseFlow - PocketFlow implementation for tool-use agents.
 *
 * Flow: PrepareNode -> CycleNode -> WaitNode (loops back to CycleNode on CONTINUE).
 */

import { Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

import { ToolUsePrepareNode, ToolUseCycleNode, ToolUseWaitNode } from './nodes';
import type { ToolUseRunShared } from './nodes';
import type { ToolUseServices, ToolUseFlowParams } from './ToolUseServices';

/** Creates a tool-use flow: prepare -> cycle -> wait (loops via CONTINUE). */
export function createToolUseFlow<C = unknown>(): Flow<
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

export type { ToolUseRunShared } from './nodes';
export type { ToolUseServices, ToolUseFlowParams } from './ToolUseServices';
