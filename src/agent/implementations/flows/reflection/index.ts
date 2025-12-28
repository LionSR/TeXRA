/**
 * Reflection flow module.
 *
 * Pure PocketFlow implementation for reflection agents.
 *
 * ## Flow-First Architecture
 *
 * The flow operates independently of the agent:
 * - Services are injected via ReflectionFlowContext
 * - Polymorphic behavior uses strategies, not agent callbacks
 * - No agent reference in flow shared state
 */

// Flow factory and types
export {
  createReflectionFlow,
  type ReflectionFlowShared,
  type ReflectionFlowState,
  type ReflectionServices,
  type ReflectionFlowParams,
} from './ReflectionFlow';

// Flow context (new flow-first pattern)
export {
  ReflectionFlowContext,
  createReflectionFlowContext,
  type ReflectionFlowContextInit,
  type ReflectionFlowStrategies,
} from './ReflectionFlowContext';

// State types
export {
  type RoundContext,
  createInitialReflectionState,
  AgentRunState,
} from './ReflectionFlowState';

// Individual nodes (for testing or extension)
export * from './nodes';
