/**
 * Reflection flow module.
 *
 * Pure PocketFlow implementation for reflection agents.
 *
 * ## Flow-First Architecture
 *
 * The flow operates independently of the agent:
 * - Services are created inline in runReflectionFlow
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
 *   streamTabId,
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

// Direct flow execution (creates services inline)
export {
  runReflectionFlow,
  type RunReflectionFlowInput,
  type RunReflectionFlowResult,
} from './runReflectionFlow';

// State types and schemas
export {
  type RoundContext,
  createInitialReflectionState,
  ReflectionFlowStateSchema,
  RoundContextSchema,
} from './ReflectionFlowState';
