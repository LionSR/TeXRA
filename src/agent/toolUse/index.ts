/**
 * Tool-use agent utilities barrel export.
 *
 * Consolidates exports for tool-use session management, follow-up handling,
 * and agent registry functions.
 */

// Follow-up queue management
export { FollowUpQueue } from './FollowUpQueue';
export { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';

// Follow-up execution
export { sendFollowUp, type SendFollowUpResult } from './ToolUseFollowUp';

// Agent registry for interrupt handling
export {
  type IInterruptible,
  registerInterruptible,
  unregisterInterruptible,
  getInterruptible,
  getToolUseFlowContext,
  cleanupInactiveAgents,
} from './ToolUseAgentRegistry';

// File interaction context (AsyncLocalStorage)
export {
  type ToolFileInteractionContext,
  withToolFileInteractionContext,
  getCurrentToolFileInteractionContext,
} from './ToolFileInteractionContext';
