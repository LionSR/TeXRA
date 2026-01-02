/**
 * Tool-use flow module.
 *
 * Service interfaces and flow-first execution for tool-use agents.
 * The flow itself is in ToolUseRunFlow.ts (parent directory).
 *
 * Architecture (refactored - no closure wrappers):
 * - Helper functions are exported for direct use by nodes
 * - Services pass context values directly (resolvedTools, snapshot, etc.)
 * - Eliminates closure indirection for cleaner call stacks
 */

export type {
  ToolUseServices,
  ToolUseFlowParams,
  PrepareStateResult,
} from './ToolUseServices';

export {
  ToolUseFlowContext,
  type ToolUseFlowContextInit,
  // Helper functions for direct use by nodes (no closure wrappers)
  prepareInitialState,
  buildCycleOptions,
  applyFollowUpMessage,
} from './ToolUseFlowContext';

export {
  ToolUseSessionLifecycle,
  type IToolUseSession,
} from './ToolUseSessionLifecycle';

export {
  runToolUseFlow,
  type RunToolUseFlowInput,
  type RunToolUseFlowResult,
  type RunToolUseFlowCallbacks,
} from './runToolUseFlow';
