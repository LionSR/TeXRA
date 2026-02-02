/**
 * Tool-use agent utilities barrel export.
 */

// Follow-up queue management
export { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';
export { sendFollowUp, type SendFollowUpResult } from './ToolUseFollowUp';

// Agent registry
export {
  type IInterruptible,
  registerInterruptible,
  unregisterInterruptible,
  getInterruptible,
  getToolUseFlowContext,
  cleanupInactiveAgents,
} from './ToolUseAgentRegistry';

// File interaction context
export {
  type ToolFileInteractionContext,
  withToolFileInteractionContext,
  getCurrentToolFileInteractionContext,
} from './ToolFileInteractionContext';
