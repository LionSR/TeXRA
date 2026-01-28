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

// Direct flow execution (creates services inline)
export {
  runReflectionFlow,
  type RunReflectionFlowInput,
  type RunReflectionFlowResult,
} from './runReflectionFlow';
