/**
 * Tool-use flow module.
 *
 * PocketFlow implementation for tool-use agents.
 *
 * ## Flow-First Architecture
 *
 * The flow operates independently of the agent:
 * - Services are created inline in runToolUseFlow
 * - Polymorphic behavior uses configuration, not agent subclasses
 * - No agent reference in flow shared state
 *
 * ## Direct Flow Execution
 *
 * Use `runToolUseFlow()` to run flows without agent class instances:
 * ```typescript
 * const result = await runToolUseFlow({
 *   modelHandler,
 *   config: agentConfig,
 *   setting: agentSetting,
 *   prompt: agentPrompt,
 *   streamId,
 *   executionId,
 * });
 * ```
 */

// Flow factory and types
export {
  createToolUseFlow,
  type ToolUseRunShared,
  type ToolUseServices,
  type ToolUseFlowParams,
} from './ToolUseFlow';

// Direct flow execution (creates services inline)
export {
  runToolUseFlow,
  type ToolUseFlowContext,
  type RunToolUseFlowInput,
  type RunToolUseFlowResult,
  type ToolUseFlowSetupCallback,
} from './runToolUseFlow';

// Session lifecycle
export {
  ToolUseSessionLifecycle,
  type IToolUseSession,
} from './ToolUseSessionLifecycle';

// State types and schemas
export type { ToolUseFlowContextInit } from './ToolUseFlowContext';
export type { StateSlicesSnapshot } from './nodes';

// Node implementations (exported for testing and extensibility)
export {
  ToolUsePrepareNode,
  ToolUseCycleNode,
  ToolUseWaitNode,
} from './nodes';
