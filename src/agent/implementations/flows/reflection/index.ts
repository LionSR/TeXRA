/**
 * Reflection flow module.
 *
 * Pure PocketFlow implementation for reflection agents.
 *
 * ## Flow-First Architecture
 *
 * The flow operates independently of the agent:
 * - Services are injected via ReflectionFlowContext
 * - Polymorphic behavior uses configuration, not agent subclasses
 * - No agent reference in flow shared state
 *
 * ## Direct Flow Execution
 *
 * Use `runReflectionFlow()` to run flows without agent class instances:
 * ```typescript
 * const result = await runReflectionFlow({
 *   modelHandler,
 *   config: agentConfig,
 *   setting: agentSetting,
 *   prompt: agentPrompt,
 *   executionContext,
 *   userVarChannels,
 * });
 * ```
 */

// Flow factory and types
export {
  createReflectionFlow,
  type ReflectionFlowShared,
  type ReflectionFlowState,
  type ReflectionServices,
  type ReflectionFlowParams,
} from './ReflectionFlow';

// Flow context (self-contained, creates own services)
export {
  ReflectionFlowContext,
  createReflectionFlowContext,
  type ReflectionFlowContextInit,
} from './ReflectionFlowContext';

// Direct flow execution (bypasses agent classes)
export {
  runReflectionFlow,
  type RunReflectionFlowInput,
  type RunReflectionFlowResult,
} from './runReflectionFlow';

// State types
export {
  type RoundContext,
  createInitialReflectionState,
  AgentRunState,
} from './ReflectionFlowState';

// Individual nodes (for testing or extension)
export * from './nodes';
