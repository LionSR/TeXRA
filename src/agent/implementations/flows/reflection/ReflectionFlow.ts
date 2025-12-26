/**
 * ReflectionFlow - Pure PocketFlow implementation for reflection agents.
 *
 * Architecture:
 * - Agent = Service Provider (provides services via getter)
 * - Flow = Execution Engine (all logic lives here)
 * - Nodes = Discrete Operations (use this.services natively)
 *
 * Service injection:
 * - Services are set via flow.setServices() (not params)
 * - Flow propagates services to all nodes automatically
 * - Nodes access via this.services getter
 *
 * Key difference from old ReflectionRunFlow:
 * - Old: Nodes called agent methods like executeCurrentRound()
 * - New: Nodes use services directly, ResponseCycleFlow composed as sub-flow
 *
 * Flow structure:
 *   InitNode → TeXCountNode → MediaPreparationNode → PrepareContextNode
 *      ↓                                                    ↓
 *      ↓                                            ResponseCycleNode
 *      ↓                                                    ↓
 *      ↓                                    OutputNode → RoundCompleteNode
 *      ↓                                                    ↓
 *      └─→ FinalizeNode ←───────────────────────────────────┘
 *                                           (CONTINUE loops back to TeXCountNode)
 */

import { Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  StandardFinalizeNode,
  StandardInitNode,
} from '@agent/implementations/flows/common';

import {
  TeXCountNode,
  MediaPreparationNode,
  PrepareContextNode,
  ResponseCycleCompositionNode,
  OutputNode,
  RoundCompleteNode,
} from './nodes';
import type { ReflectionFlowShared } from './ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from './ReflectionServices';

// ============================================================================
// Custom Init Node
// ============================================================================

/**
 * Initializes the reflection flow.
 *
 * Extends StandardInitNode to call resetPromptBuilder() before starting rounds.
 * Transitions to 'prepare_workspace' phase (TeXCountNode now handles workspace init).
 *
 * Uses IReflectionFlowAgent (via shared.agent) for flow-specific methods,
 * following the same pattern as ToolUseFlow with IToolUseFlowAgent.
 */
class ReflectionInitNode extends StandardInitNode<ReflectionFlowShared> {
  constructor() {
    super('prepare_workspace');
  }

  protected override beforeStart(shared: ReflectionFlowShared): void {
    // Call directly on agent (IReflectionFlowAgent interface)
    shared.agent.resetPromptBuilder();
  }
}

// ============================================================================
// Flow Factory
// ============================================================================

/**
 * Creates a reflection flow with native services support.
 *
 * Usage:
 * ```typescript
 * const flow = createReflectionFlow<C>();
 * flow.setServices(agent.services);
 * await flow.run(shared);
 * ```
 *
 * @template C - Client type (e.g., Anthropic, OpenAI client)
 */
export function createReflectionFlow<C = unknown>(): Flow<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  // Create all nodes
  const initNode = new ReflectionInitNode();
  const texCountNode = new TeXCountNode<C>();
  const mediaNode = new MediaPreparationNode<C>();
  const prepContextNode = new PrepareContextNode<C>();
  const responseCycleNode = new ResponseCycleCompositionNode<C>();
  const outputNode = new OutputNode<C>();
  const roundCompleteNode = new RoundCompleteNode<C>();
  const finalizeNode = new StandardFinalizeNode<ReflectionFlowShared>(
    'finalize',
  );

  // Wire linear flow (happy path)
  // TeXCountNode creates workspace state and computes texcount
  initNode.next(texCountNode);
  texCountNode.next(mediaNode); // Media extraction
  mediaNode.next(prepContextNode); // Build context

  // Response cycle pipeline
  prepContextNode.next(responseCycleNode);
  responseCycleNode.next(outputNode);
  outputNode.next(roundCompleteNode);

  // Wire branches
  initNode.on(FlowTransition.FINALIZE, finalizeNode);
  prepContextNode.on(FlowTransition.CONTINUE, texCountNode); // Skip round
  responseCycleNode.on(FlowTransition.FINALIZE, finalizeNode); // Cycle failed
  roundCompleteNode.on(FlowTransition.CONTINUE, texCountNode); // Next round
  roundCompleteNode.on(FlowTransition.FINALIZE, finalizeNode); // Done

  return new Flow<
    ReflectionFlowShared,
    ReflectionFlowParams,
    ReflectionServices<C>
  >(initNode);
}

// Re-export types for convenience
export type {
  IReflectionFlowAgent,
  ReflectionFlowShared,
  ReflectionFlowState,
} from './ReflectionFlowState';
export type {
  ReflectionServices,
  ReflectionFlowParams,
} from './ReflectionServices';
