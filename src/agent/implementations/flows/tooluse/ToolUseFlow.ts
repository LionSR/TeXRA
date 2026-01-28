/**
 * ToolUseFlow - PocketFlow implementation for tool-use agents.
 *
 * Architecture:
 * - Services injected via flow.setServices(), accessed via this.services
 * - shared contains only mutable state (memories)
 * - PersistedFlow handles persistence transparently
 *
 * Flow structure:
 *   ToolUsePrepareNode → ToolUseCycleNode → ToolUseWaitNode
 *                              ↑                    ↓
 *                              └──── CONTINUE ──────┘
 *
 * Node implementations are in ./nodes/:
 * - ToolUsePrepareNode: Initializes session state
 * - ToolUseCycleNode: Runs tool-use cycles (API call + tool execution)
 * - ToolUseWaitNode: Waits for follow-up messages
 *
 * Usage:
 * ```typescript
 * const flow = createToolUseFlow<C>();
 * flow.setServices(services);
 * await flow.run(shared);
 * ```
 *
 * @template C - Client type (e.g., Anthropic, OpenAI client)
 */

import { Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

import { ToolUsePrepareNode, ToolUseCycleNode, ToolUseWaitNode } from './nodes';
import type { ToolUseRunShared } from './nodes';
import type { ToolUseServices, ToolUseFlowParams } from './ToolUseServices';

// ============================================================================
// Flow Factory
// ============================================================================

/**
 * Creates a tool-use flow: prepare → cycle → wait (loop via CONTINUE).
 *
 * The flow structure is:
 * 1. ToolUsePrepareNode: Initialize or resume session state
 * 2. ToolUseCycleNode: Run model + tool cycles
 * 3. ToolUseWaitNode: Wait for follow-up, then loop back to cycle
 */
export function createToolUseFlow<C = unknown>(): Flow<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  // Create nodes
  const prepareNode = new ToolUsePrepareNode<C>();
  const cycleNode = new ToolUseCycleNode<C>();
  const waitNode = new ToolUseWaitNode<C>();

  // Wire linear flow
  prepareNode.next(cycleNode);
  cycleNode.next(waitNode);

  // Wire continuation loop
  waitNode.on(FlowTransition.CONTINUE, cycleNode);

  return new Flow<ToolUseRunShared, ToolUseFlowParams, ToolUseServices<C>>(
    prepareNode,
  );
}

// Re-export types for convenience (matches ReflectionFlow.ts pattern)
export type { ToolUseRunShared } from './nodes';
export type { ToolUseServices, ToolUseFlowParams } from './ToolUseServices';
