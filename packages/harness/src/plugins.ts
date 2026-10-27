/**
 * Built-in plugins (`harnessBuiltins`) and the plugin authoring surface for
 * `@texra-ai/harness`.
 *
 * > **Guide:** Read [Plugins, Tools & Codemode](/api/plugins-and-codemode) for
 * > how to author tools and plugins, how step-pinned catalogs work, and how the
 * > `script` (Codemode) sandbox replays across crashes.
 *
 * ### Key exports by role
 *
 * - **Built-in plugins**: [`harnessBuiltins`](#harnessbuiltins) bundles
 *   [`codemode`](#codemode), [`fileOps`](#fileops), [`goal`](#goal),
 *   [`memoryWorkflow`](#memoryworkflow), [`multiAgent`](#multiagent)
 *   ([`AGENT_TOOL_NAME`](#agent_tool_name)), and [`web`](#web) for
 *   `Sessions.layer({ platform, plugins })`.
 * - **Plugin & tool authoring**: [`definePlugin`](#defineplugin),
 *   [`executed`](#executed), [`errorResult`](#errorresult),
 *   [`ToolError`](#toolerror), [`nullishWithDefault`](#nullishwithdefault),
 *   [`resolveToolPath`](#resolvetoolpath), and file-edit approval helpers
 *   ([`requestToolEditApproval`](#requesttooleditapproval),
 *   [`buildApprovalRejectedResult`](#buildapprovalrejectedresult),
 *   [`approvedWriteConflict`](#approvedwriteconflict)).
 * - **Runtime callbacks inside a tool**: [`requireRun`](#requirerun),
 *   [`callerRun`](#callerrun), [`ChildRuns`](#childruns), and
 *   [`RunInbox`](#runinbox).
 * - **Lifetimes, prompt sections & durable rows**:
 *   [`ALWAYS_AVAILABLE`](#always_available), [`PromptSection`](#promptsection),
 *   [`ProcessPluginLayer`](#processpluginlayer),
 *   [`SessionPluginLayer`](#sessionpluginlayer), [`PluginHold`](#pluginhold),
 *   [`RequestDecisionHook`](#requestdecisionhook), [`PluginArm`](#pluginarm),
 *   and [`AgentBlock`](#agentblock) ([`agentBlockOf`](#agentblockof)).
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
  type ChildRunsShape,
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
} from '@agent/followUp/followUpMessages';
// What a call's requests and a decision hook's commits fail with.
export type { LogWriteError } from '@agent/runtime/SessionHandle';
export type { CellError, RunHistoryRefused } from '@shared/session/runHistory';
export type { RunHistoryInconsistent } from '@shared/session/runState';
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
