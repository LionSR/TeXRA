/**
 * Agent runtime — the cross-host public surface of `src/agent/runtime`.
 *
 * One curated barrel the hosts (CLI, desktop, extension) import instead of
 * deep-reaching each runtime module by path. Following the same pattern as
 * `@agent/trace` and `@agent/storage`, this decouples host code from the
 * runtime's internal file layout: moving or splitting a module below no longer
 * ripples into every host, and the R-b deep-import width ratchet
 * (`config/ratchets/host-agent-import-baseline.json`) collapses each host's
 * many `@agent/runtime/*` specifiers to this single door.
 *
 * The surface is derived from use — exactly the symbols the three hosts reach
 * for today — per the Agent-SDK north star
 * (`docs/proposals/2026-07-09-agent-sdk-north-star.md`, §2) and the fold-in
 * plan (`docs/proposals/2026-08-04-agent-sdk-readiness-review.md`, §3/§5).
 * Internal runtime modules keep importing each other by direct path; nothing
 * inside `src/agent` imports this barrel, so it introduces no import cycle.
 */

// SessionHandle
export {
  SessionHandle,
  currentSession,
  defaultSession,
  initializeDefaultSession,
  teardownDefaultSession,
  tryDefaultSession,
} from './SessionHandle';
export type { WorkspaceStorageTransitionHooks } from './SessionHandle';

// SessionEventHub
export { SessionEventHub } from './SessionEventHub';
export type { SessionEvent, SessionFact } from './SessionEventHub';

// HostInteractions
export {
  SessionHostInteractions,
  matchesCancelSelector,
} from './HostInteractions';
export type {
  BashSettlement,
  HostAgentProposalRequest,
  HostApprovalBypassStateUpdate,
  HostBashApprovalRequest,
  HostInteractionCancelSelector,
  HostInteractions,
  HostRetryInteractionOptions,
  HostRetryRequest,
  HostUserQuestionRequest,
  ManualCriticismEntry,
  PlanApprovalResult,
  ProposalResult,
  RetryResult,
  UserQuestionSettlement,
} from './HostInteractions';

// runAgent
export { runAgent } from './runAgent';
export type { RunAgentOptions } from './runAgent';

// SessionResumeRetrieval
export { retrieveSessionResumeData } from './SessionResumeRetrieval';
export type { ToolUseResumeData } from './SessionResumeRetrieval';

// terminalResultToast
export {
  attachTerminalResultToast,
  trackTerminalResultPresentation,
} from './terminalResultToast';

// resolveAndResumeStream
export {
  resolveAndResumeStream,
  resolveResumeStateFromSnapshots,
} from './resolveAndResumeStream';

// detachSubagentsOnStop
export { detachSubagentsOnStop } from './detachSubagentsOnStop';

// runtimePresentationEvents
export {
  dispatchPresentationEvent,
  toPresentationDelivery,
} from './runtimePresentationEvents';
export type {
  PresentationDelivery,
  PresentationEventHandlers,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

// resumeQueuedToolUse
export { resumeQueuedToolUseFromResumeData } from './resumeQueuedToolUse';

// executionRegistry
export type { ManualCompactionRequestResult } from './executionRegistry';

// executeAgent
export { resumeToolUseFromResumeData } from './executeAgent';

// textEnhancement
export { polishTextWithAI } from './textEnhancement';
export type { FileContext } from './textEnhancement';

// selectAutoOpenFinalOutput
export { selectAutoOpenFinalOutput } from './selectAutoOpenFinalOutput';

// modelHandlerCompatibilityKey
export { ModelHandlerCompatibilityKeySchema } from './modelHandlerCompatibilityKey';
export type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

// helperModelName
export { getHelperModelName } from './helperModelName';

// ExecutionHandle
export type { AgentRunHandle } from './ExecutionHandle';

// bundledPrompts
export { initializeBundledPrompts } from './bundledPrompts';

// AgentFlowResult
export type { WorkflowFlowResult } from './AgentFlowResult';

// core/state projection used by the CLI's frozen progress wire.
export { agentConfigToTaskState } from '../core/state/agentConfigToTaskState';
