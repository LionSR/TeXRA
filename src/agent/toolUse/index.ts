/**
 * Tool-use agent utilities barrel export.
 */

// Follow-up queue and item types
export {
  type FollowUpItem,
  textFollowUp,
  resumeToolFollowUp,
  followUpDisplayText,
  processFollowUpItems,
} from './FollowUpQueue';
export { ToolUseFollowUpQueue } from './ToolUseFollowUpQueueManager';
export {
  sendFollowUp,
  sendFollowUpItem,
  type SendFollowUpResult,
} from './ToolUseFollowUp';
export { handleResumeToolFollowUp } from './resumeToolHandler';

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
