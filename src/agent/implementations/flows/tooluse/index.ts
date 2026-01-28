/**
 * Tool-use flow module.
 *
 * Entry point: `runToolUseFlow()` runs flows directly with configuration.
 * Flow factory: `createToolUseFlow()` for lower-level control.
 */

export {
  createToolUseFlow,
  type ToolUseRunShared,
  type ToolUseServices,
  type ToolUseFlowParams,
} from './ToolUseFlow';

export {
  runToolUseFlow,
  type ToolUseFlowContext,
  type RunToolUseFlowInput,
  type RunToolUseFlowResult,
  type ToolUseFlowSetupCallback,
} from './runToolUseFlow';

export {
  ToolUseSessionLifecycle,
  type IToolUseSession,
} from './ToolUseSessionLifecycle';

export type { ToolUseFlowContextInit } from './ToolUseFlowContext';
export type { StateSlicesSnapshot } from './nodes';
export { ToolUsePrepareNode, ToolUseCycleNode, ToolUseWaitNode } from './nodes';
