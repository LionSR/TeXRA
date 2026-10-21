/**
 * `@texra-ai/harness/plugins`: the harness's built-in plugins, as the values
 * an embedder lists for `Sessions.layer({ platform, plugins })`.
 * `harnessBuiltins` is every built-in. An embedder adds its own plugins
 * beside them.
 *
 * A plugin's tool reads the run its call works for through `ToolContext`:
 * `requireRun` (the run, or the shared refusal) and `callerRun` (the run,
 * if any), typed `ToolRun`. A plugin's tool may require `PluginToolServices`
 * (never the harness's own call services), and reaches the session's runs
 * only through `ChildRuns`: it launches a child, and sends a run its input
 * (`RunInbox`). A plugin that owns a block of an agent file (`AgentBlock`)
 * reads an agent's block with `agentBlockOf`.
 *
 * An app defines a plugin with `definePlugin`; its tools return `executed` or
 * `errorResult`, give an omitted input field its default with
 * `nullishWithDefault`, resolve a path the model names against the call's
 * roots with `resolveToolPath`, and read a request's answer they do not
 * accept as its refusal with `refusalOf`. A plugin's process services are its
 * `ProcessPluginLayer`; work that outlives its step holds the session layer
 * with `PluginHold`; a plugin that records the decisions on a request kind
 * is that kind's `RequestDecisionHook`. The process's plugin table is the
 * `ToolRegistry` service. A tool refuses a call by failing with `ToolError`;
 * `fileOps` takes the `WriteFilter` its `write_file` applies.
 */
export {
  codemode,
  fileOps,
  goal,
  harnessBuiltins,
  memoryWorkflow,
  multiAgent,
  web,
} from '@tools/builtinPlugins';
/** The name of the `multiAgent` plugin's tool, which runs a named agent as
 *  a child of the calling run: an agent whose tools name it orchestrates. */
export { AGENT_TOOL_NAME } from '@shared/constants/delegationTools';
export {
  definePlugin,
  type PluginArm,
  type PluginDefinition,
  type PluginRow,
} from '@tools/plugins';
export type { WriteFilter } from '@tools/WriteTool';
export {
  agentBlockOf,
  PluginHold,
  ToolRegistry,
  type AgentBlock,
  type AgentBlockResult,
  type PluginContinuation,
  type PluginLayerServices,
  type ProcessPluginLayer,
  type PromptSection,
  type RecipeChange,
  type RequestDecisionHook,
  type SessionPluginLayer,
  type ToolTable,
} from '@tools/toolTable';
export type { DefineToolOptions } from '@tools/core/definition';
// A plugin's availability: the check of one that needs nothing installed,
// and the one failure a probe raises.
export { ALWAYS_AVAILABLE, ToolProbeFailed } from '@tools/toolProbes';
export { errorResult, executed } from '@tools/core/result';
// A listing's output text: its header over its lines, or a note for none.
export { formatToolOutput } from '@tools/formatting';
// A workspace file as a call's attachment, and the workspace's ignore policy.
export {
  buildFileAttachment,
  type BuildFileAttachmentOptions,
} from '@tools/attachments';
export { getGitignoreMatcher, type GitignoreMatcher } from '@tools/gitignore';
// Asking the person for an edit, the result a refusal returns, and the
// write of the approved content (a conflict is the value, not a failure).
export {
  buildApprovalRejectedResult,
  requestToolEditApproval,
  type ToolEditApprovalResult,
  type ToolEditProposal,
} from '@tools/approval/toolEditApproval';
export {
  approvedWriteConflict,
  type ApprovedEditConflictError,
} from '@tools/approval/approvedWrite';
// JSON-RPC 2.0 over a child process's stdio (a language server's framing,
// or one message per line).
export {
  makeJsonRpcConnection,
  type JsonRpcConnection,
  type JsonRpcConnectionDisposed,
  type JsonRpcConnectionOptions,
  type JsonRpcRequestError,
} from '@tools/jsonRpc';
// A request's answer the tool does not accept, read as the refusal it is.
export { refusalOf } from '@shared/session/approvalDecision';
export type { RefusalDecision } from '@shared/schemas';
export {
  ToolError,
  type EditRecord,
  type ToolFileAttachment,
} from '@shared/schemas';
export { nullishWithDefault } from '@tools/core/inputSchema';
export {
  assertNoParentTraversal,
  parseWorkingDirectory,
  resolveToolPath,
  type ToolPathCall,
  type ToolPathResolution,
  type WorkspacePathResolution,
} from '@tools/pathResolution';
/** The `web` plugin's fetch tool, typed with what its call requires, for a
 *  host that calls it outside a run (the editor's Copilot tools). */
export { WebFetchTool } from '@tools/web/WebFetchTool';
// The memory tool's tree as a host reads and edits it outside a run, over
// the session's storage view.
export {
  MemoryStore,
  type MemoryPinResult,
  type MemoryPreview,
} from '@tools/memory/memoryStore';
export { callerRun, requireRun } from '@agent/runtime/RunCall';
export {
  ChildRuns,
  type CallServices,
  type PluginToolServices,
} from '@agent/runtime/ToolServices';
// What `ChildRuns` launches: an agent's child, or an external process's
// with the strategy its loop runs. A tool that launches children takes the
// call fields every child launch takes (`CALL_FIELDS`) and its file lists
// as `fileList` fields.
export {
  CALL_FIELDS,
  fileList,
  type ChildLaunch,
} from '@tools/delegation/AgentTool';
export type { ProcessChildLaunch } from '@tools/delegation/detachedChildRun';
export type {
  ChildRunPause,
  ChildStrategyBase,
  ProcessChildStrategy,
} from '@agent/runtime/childRunLoop';
// The XML a child's settled turn delivers to its parent.
export {
  formatDelivery,
  type ChildRunDelivery,
} from '@agent/runtime/deliveryEnvelope';
// A run's input as a plugin sends it, and how the send landed.
export type {
  FollowUpFailureReason,
  RunInbox,
  RunInboxSendOptions,
  SubmitFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
export type { InboxItem } from '@agent/followUp/Inbox';
export {
  senderOf,
  type FollowUpSenderInput,
} from '@agent/followUp/followUpSender';
// What a call's requests and a decision hook's commits fail with.
export type { LogWriteError } from '@agent/runtime/SessionHandle';
export type { CellError, RunHistoryRefused } from '@shared/session/runHistory';
export type { RunHistoryInconsistent } from '@shared/session/runStateFold';
export type { StepRoot } from '@utils/files/externalRoots';
// The run a plugin's tool reads (`ToolRun`) and the pieces it names: its
// policy, opening, trace and stages, model binding and run files.
export type { ToolRun } from '@agent/core/tools/ToolTypes';
export type { ToolPolicy } from '@agent/runtime/run/AgentRun';
// Renders a prompt template (Nunjucks) with its variables.
export { renderPrompt } from '@utils/prompt';
export {
  buildTemplatePassthrough,
  type TemplateInputs,
  type TemplateOpening,
  type TemplateVars,
} from '@agent/prompt/templateInputs';
export type {
  AgentTrace,
  LogOptions,
  StageHandle,
  StageOptions,
  StreamHandle,
  StreamOptions,
  ToolCardHandle,
} from '@agent/trace/AgentTrace';
export type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
export type {
  ModelRetryGate,
  RouteFailure,
  RouteOptions,
  RoutePolicy,
} from '@agent/runtime/ModelRetryGate';
// A run's files under its session storage: its directory, the pre-run
// snapshots and workspace mirrors it prepares, and output locations.
export { RunFileService, type RunStorageEntry } from '@utils/files/runStorage';
export { HostCapabilities } from '@agent/runtime/agentToolResolution';
// The harness's retry policy: which HTTP statuses are worth retrying, the
// randomized exponential backoff `Schedule` its fetches retry on, and the
// capped, jittered delay a caller that sleeps for itself waits.
export { jitteredExponentialBackoffMs } from '@utils/core';
export { randomizedExponentialBackoff } from '@utils/core/backoffSchedule';
export { isTransientHttpStatus } from '@utils/core/httpStatus';
// A tool's requests: one attempt under a deadline, the transient-failure
// retry, the scoped clients an attempt's scope aborts, and whether a failure
// got no answer at all.
export {
  isTransportReason,
  retryTransientFetch,
  scopedClient,
  type RetryTransientFetchOptions,
  scopedOkClient,
  withRequestTimeout,
} from '@tools/timeouts';
