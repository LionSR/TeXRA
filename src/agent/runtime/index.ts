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

// RunContext: the session scope a host enters around every touch of a
// session's storage when it holds several sessions in one process.
export { runInSession } from './RunContext';

// The process identity a composition root resolves for its Effect runtime
// (`installProcessRuntime`), from the host's own start identity.
export { processOwnerId } from './SessionEvents';

// StreamStatusMachine — the per-stream lifecycle record hosts render from
// (`SessionState.streamStatus.getStreamState`). Type only: the machine itself
// is reached through the session, never constructed by a host.

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
export type { RunAgentOptions, RunAgentRequest } from './runAgent';

// SessionResumeRetrieval
export { retrieveSessionResumeData } from './SessionResumeRetrieval';

// runClassification
export { classifyRun } from './runClassification';

// terminalResultToast
export {
  attachTerminalResultToast,
  trackTerminalResultPresentation,
} from './terminalResultToast';

// resumeRun
export { lookupStreamExecutionId, resumeRun } from './resumeRun';
export type { ResumeRunOptions } from './resumeRun';
// The refusal wording a host applies to a `ResumeRunResult` failure, and the
// stream -> execution lookup the stream-keyed host resume ports need.
export { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';

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

// textEnhancement
export { polishTextWithAI } from './textEnhancement';

// selectAutoOpenFinalOutput
export { selectAutoOpenFinalOutput } from './selectAutoOpenFinalOutput';

// persistedCompileRejection
export {
  hasTerminalPersistedCompileRejection,
  isTerminalPersistedCompileRejection,
} from './persistedCompileRejection';

// modelHandlerCompatibilityKey
export { ModelHandlerCompatibilityKeySchema } from './modelHandlerCompatibilityKey';

// helperModelName
export { getHelperModelName } from './helperModelName';

// textConnection
export { agentResponseTextConnector } from './textConnection';

// ExecutionHandle
export type { AgentRunHandle } from './ExecutionHandle';

// bundledPrompts
export { initializeBundledPrompts } from './bundledPrompts';

// AgentFlowResult
export type { WorkflowFlowResult } from './AgentFlowResult';

// core/state projection used by the CLI's frozen progress wire.
export { agentConfigToTaskState } from '../core/state/agentConfigToTaskState';

// core/definition config contract used by host launch/resume seams.
export {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '../core/definition/AgentConfig';
