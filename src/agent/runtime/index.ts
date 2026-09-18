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
 * (`.agents/docs/archived/architecture/2026-07-09-agent-sdk-north-star.md`, §2) and the fold-in
 * plan (`.agents/docs/archived/architecture/2026-08-04-agent-sdk-readiness-review.md`, §3/§5).
 * Internal runtime modules keep importing each other by direct path; nothing
 * inside `src/agent` imports this barrel, so it introduces no import cycle.
 */

// SessionHandle
export {
  SessionHandle,
  initializeDefaultSession,
  teardownDefaultSession,
} from './SessionHandle';

// sessionGraph: the process's session owner, as the hosts and the SDK open
// and close sessions through it (one session per workspace storage root).
export {
  closeSession,
  installedProcessRuntime,
  listSessions,
  openSessionEffect,
  tryDefaultSession,
} from './sessionGraph';

// HostInteractions
export { SessionHostInteractions } from './HostInteractions';
export type {
  HostInteractions,
  ManualCriticismEntry,
} from './HostInteractions';

// runRegistry: the session's `Runs`. A launch provides it from the session it
// is on; a host invoking a tool outside any run provides `session.runs`.
export { Runs } from './runRegistry';

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
  presentAgentFailure,
  trackTerminalResultPresentation,
} from './terminalResultToast';

// resumeRun
export { resumeRun } from './resumeRun';
export type { ResumeRunOptions } from './resumeRun';
// The refusal wording a host applies to a `ResumeRunResult` failure.
export { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';

// detachSubagentsOnStop
export { detachSubagentsOnStop } from './detachSubagentsOnStop';

// runtimePresentationEvents
export {
  DiagnosticsReadFailed,
  PdfOpenFailed,
} from './runtimePresentationEvents';
export type {
  HostPresentation,
  PresentationEventHandlers,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

// selectAutoOpenFinalOutput
export { selectAutoOpenFinalOutput } from './selectAutoOpenFinalOutput';

// helperModelName
export { getHelperModelName } from './helperModelName';

// textConnection
export { createAgentResponseTextConnector } from './textConnection';

// RunHandle
export type { AgentRunHandle } from './RunHandle';

// AgentFlowResult
export type { WorkflowFlowResult } from './AgentFlowResult';

// agentLoad: the definition a launch actually loads, for hosts that must read
// a declared field (a remote agent's `defaultOutputFiles`) the catalog listing
// does not carry.
export { loadAgentSettingAndPrompts } from './agentLoad';

// core/definition config contract used by host launch/resume seams.
export {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '../core/definition/AgentConfig';

// core/state run-request validation at the host launch boundary.
export {
  validateRunRequest,
  type RunRequest,
  type ValidatedRunRequest,
} from '../core/state/runRequests';

// Native tool host capabilities, supplied per standalone invocation.
export { ToolCall } from './ToolCall';
export { FileInteractionState } from '../core/state/AgentWorkspaceState';
