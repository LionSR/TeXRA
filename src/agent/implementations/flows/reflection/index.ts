/**
 * Reflection flow module.
 *
 * Pure PocketFlow implementation for reflection agents.
 * Agent provides services, flow does all execution via nodes.
 */

// Flow factory and types
export {
  createReflectionFlow,
  type IReflectionFlowAgent,
  type ReflectionFlowShared,
  type ReflectionFlowState,
  type ReflectionServices,
  type ReflectionFlowParams,
} from './ReflectionFlow';

// State types
export {
  type RoundContext,
  createInitialReflectionState,
  AgentRunState,
} from './ReflectionFlowState';

// Individual nodes (for testing or extension)
export * from './nodes';
