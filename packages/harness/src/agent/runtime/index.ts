/**
 * Agent runtime — the cross-host public surface of `packages/harness/src/agent/runtime`.
 *
 * One curated barrel the hosts (CLI, desktop, extension) import instead of
 * deep-reaching each runtime module by path. Following the same pattern as
 * `@agent/trace` and `@agent/storage`, this decouples host code from the
 * runtime's internal file layout: moving or splitting a module below no longer
 * ripples into every host, and the harness deep-import ratchet
 * (`config/ratchets/harness-deep-import-baseline.json`) collapses each host's
 * many `@agent/runtime/*` specifiers to this single door.
 *
 * The surface is derived from use — exactly the symbols the three hosts reach
 * for today — per the Agent-SDK north star
 * (`2026-07-09-agent-sdk-north-star.md`, §2) and the fold-in
 * plan (`2026-08-04-agent-sdk-readiness-review.md`, §3/§5).
 * Internal runtime modules keep importing each other by direct path; nothing
 * inside `src/agent` imports this barrel, so it introduces no import cycle.
 */

// SessionHandle
export type { SessionHandle, SessionViewAccess } from './SessionHandle';

// The shutdown budget a host spends closing its sessions.
export { SESSION_CLOSE_DEADLINE_MS } from './SessionHandle';

// The process's one route retry gate, which a helper call reads from context.
export type { RouteRetries } from './run/invocation';

// HostInteractions
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

// runClassification
export { runRefusal } from './runClassification';

// terminalResultToast
export {
  presentRunFailure,
  terminalFailurePresented,
} from './terminalResultToast';

// resumeRun
export { resumeRun } from './resumeRun';
export type { ResumeRunOptions, ResumeRunResult } from './resumeRun';
// The refusal wording a host applies to a `ResumeRunResult` failure.
export { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';

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

// RunHandle

// RunEndResult
export type { RunEndResult } from './RunEndResult';

// core/definition config contract used by host launch/resume seams.
export {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '../core/definition/AgentConfig';

// core/state run-request validation at the host launch boundary.
export {
  validateRunRequest,
  type ValidatedRunRequest,
} from '../core/state/runRequests';

// Native tool host capabilities, supplied per standalone invocation.
export { ToolContext } from '@agent/core/tools/ToolTypes';
export { IssuingScript, RunCall, ScriptCalls } from './RunCall';
export { childRunsLayer } from './ToolServices';

// A workflow run's delivered outputs with their diffs, for a host that prints them.
export { withWorkflowDiffs } from './subagentResults';
