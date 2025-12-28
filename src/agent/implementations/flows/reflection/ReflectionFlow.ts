/**
 * ReflectionFlow - Pure PocketFlow implementation for reflection agents.
 *
 * Architecture:
 * - Agent = Service Provider (provides services via getter)
 * - Flow = Execution Engine (all logic lives here)
 * - Nodes = Discrete Operations (use this.services natively)
 * - Agent owns lifecycle (init before flow, finalize in agent.run() finally)
 *
 * Service injection:
 * - Services are set via flow.setServices() (not params)
 * - Flow propagates services to all nodes automatically
 * - Nodes access via this.services getter
 *
 * Error handling:
 * - Nodes throw errors directly
 * - agent.run() catches errors and handles cleanup in finally block
 * - FlowTransition.FINALIZE ends the flow gracefully (no error)
 *
 * Flow structure (Option 3: PrepareContext first):
 *   PrepareContextNode → TeXCountNode → MediaPreparationNode
 *        ↑                                        ↓
 *        │                                ResponseCycleNode
 *        │                                        ↓
 *        │                        OutputNode → RoundCompleteNode
 *        │                                        ↓
 *        └─────────────────────────── CONTINUE (next round)
 *                                     FINALIZE (done, flow ends)
 *
 * Each node enriches the context:
 * - PrepareContext: builds base messages
 * - TeXCount: prepends stats to user message
 * - Media: adds media files to user message
 */

import { Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

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
// Flow Factory
// ============================================================================

/**
 * Creates a reflection flow with native services support.
 *
 * Note: Agent owns lifecycle - init/finalize are handled in agent.run().
 * This flow contains only the work nodes.
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
  // Create work nodes only (no init/finalize - agent owns lifecycle)
  const prepContextNode = new PrepareContextNode<C>();
  const texCountNode = new TeXCountNode<C>();
  const mediaNode = new MediaPreparationNode<C>();
  const responseCycleNode = new ResponseCycleCompositionNode<C>();
  const outputNode = new OutputNode<C>();
  const roundCompleteNode = new RoundCompleteNode<C>();

  // Wire linear flow (happy path) - PrepareContext first!
  prepContextNode.next(texCountNode); // Enrich with TeXCount stats
  texCountNode.next(mediaNode); // Enrich with media files
  mediaNode.next(responseCycleNode); // Run response cycle

  // Response cycle pipeline
  responseCycleNode.next(outputNode);
  outputNode.next(roundCompleteNode);

  // Wire branches
  prepContextNode.on(FlowTransition.CONTINUE, prepContextNode); // Skip round (loops back)
  roundCompleteNode.on(FlowTransition.CONTINUE, prepContextNode); // Next round
  // FlowTransition.FINALIZE has no target - flow ends gracefully

  return new Flow<
    ReflectionFlowShared,
    ReflectionFlowParams,
    ReflectionServices<C>
  >(prepContextNode); // Start at PrepareContextNode
}

// Re-export types for convenience
export type {
  ReflectionFlowShared,
  ReflectionFlowState,
} from './ReflectionFlowState';
export type {
  ReflectionServices,
  ReflectionFlowParams,
} from './ReflectionServices';
