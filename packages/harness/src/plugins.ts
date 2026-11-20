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
 *   (the `agent` tool, [`AGENT_TOOL_NAME`](#agent_tool_name), and the
 *   `program` tool), and [`web`](#web) for
 *   `Sessions.layer({ platform, plugins, client })`.
 * - **Plugin & tool authoring**: [`defineTool`](#definetool),
 *   [`definePlugin`](#defineplugin) and the
 *   [`Plugin`](#plugin) it returns (what a plugin package declares it exports),
 *   [`executed`](#executed), [`errorResult`](#errorresult),
 *   [`ToolError`](#toolerror), [`nullishWithDefault`](#nullishwithdefault),
 *   [`optionalInput`](#optionalinput),
 *   [`resolveToolPath`](#resolvetoolpath), and file-edit approval helpers
 *   ([`requestToolEditApproval`](#requesttooleditapproval),
 *   [`buildApprovalRejectedResult`](#buildapprovalrejectedresult),
 *   [`approvedWriteConflict`](#approvedwriteconflict)).
 * - **Runtime callbacks inside a tool**: the call's run and requests on
 *   [`ToolContext`](#toolcontext), [`ChildRuns`](#childruns), and
 *   [`RunInbox`](#runinbox).
 * - **Settings, stores & signals**: [`Settings`](#settings) over a
 *   [`ConfigProvider`](#configprovider) and a [`StateStore`](#statestore)
 *   (failing with [`StateReadFailed`](#statereadfailed),
 *   [`StateWriteFailed`](#statewritefailed) or
 *   [`ConfigWriteFailed`](#configwritefailed)), the rooted file systems
 *   ([`WorkspaceFs`](#workspacefs), [`StorageFs`](#storagefs),
 *   [`GlobalStorageFs`](#globalstoragefs)), and the process services a
 *   plugin layer may read ([`AppState`](#appstate),
 *   [`GlobalValues`](#globalvalues), [`ToolCatalog`](#toolcatalog),
 *   [`AppSignals`](#appsignals)).
 * - **Lifetimes, prompt sections & durable rows**:
 *   [`PromptSection`](#promptsection),
 *   [`ProcessPluginLayer`](#processpluginlayer),
 *   [`SessionPluginLayer`](#sessionpluginlayer), [`PluginHold`](#pluginhold),
 *   [`FactKind`](#factkind), and [`Program`](#program) (how its run
 *   reads: [`ProgramResult`](#programresult)).
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
export { AGENT_TOOL_NAME } from '@shared/schemas';
export {
  definePlugin,
  type FactKind,
  type FactKinds,
  type Plugin,
  type PluginDefinition,
} from '@tools/plugins';
export type { WriteFilter } from '@tools/WriteTool';
export {
  PluginHold,
  ToolRegistry,
  type Program,
  type ProgramResult,
  type PluginLayerServices,
  type ProcessPluginLayer,
  type PromptSection,
  type ProgramChange,
  type SessionPluginLayer,
  type ToolTable,
} from '@tools/toolTable';
// A tool: defined once, passed to a run as `start({ tools })` or listed by
// a plugin, and the result its body answers with.
export {
  defineTool,
  type DefinedTool,
  type DefineToolOptions,
} from '@tools/core/definition';
export type { ITool } from '@tools/core/ToolTypes';
export type { ToolResult } from '@shared/schemas';
// A plugin's availability check, and the one failure a probe raises.
export {
  ToolProbeFailed,
  type ToolAvailabilityChecks,
  type ToolProbeError,
  type ToolProbeInputs,
  type ToolProbeServices,
} from '@tools/toolProbes';
// What a tool's body reads from its call: the run, its roots and its
// requests (`ToolContext`), and the guard that may refuse a call first.
export {
  ToolContext,
  type CallRequests,
  type ToolContextShape,
  type ToolEnv,
  type ToolGuard,
} from '@tools/core/ToolTypes';
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
// The diff engine behind every edit card's counts and diff body: a change's
// unified-diff hunks, their line counts and text, and the warning a diff
// that ran past its bound logs.
export {
  buildDiffHunks,
  countLineChanges,
  reportDiffTimeout,
  unifiedDiffText,
  type DiffHunks,
  type Hunk,
} from '@tools/unifiedDiff';
// JSON-RPC 2.0 over a child process's stdio (a language server's framing,
// or one message per line).
export {
  makeJsonRpcConnection,
  type JsonRpcConnection,
  type JsonRpcConnectionDisposed,
  type JsonRpcConnectionOptions,
  type JsonRpcRequestError,
} from '@tools/jsonRpc';
// What a request of each kind is answered with, and the three ways any
// request is declined.
export type { DecisionOf, RefusalDecision } from '@shared/schemas';
export {
  ToolError,
  type EditRecord,
  type ToolFileAttachment,
} from '@shared/schemas';
export { nullishWithDefault, optionalInput } from '@tools/core/inputSchema';
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
export { noLaterTurn } from '@agent/runtime/RunCall';
export {
  ChildRuns,
  type ChildRunsShape,
  type PluginToolServices,
} from '@agent/runtime/ToolServices';
// What a tool body and a plugin layer read beyond their call: the rooted
// file systems, catalog settings against the caller's stores, the
// process's secrets and app signals, the log channel its entries name, and
// the budget a session close gives a plugin's drain.
export { GlobalStorageFs, StorageFs, WorkspaceFs } from '@platform/rootedFs';
export type { RootedFileSystem } from '@utils/files/rootedFileSystem';
// Settings, the config and state store ports they are read and written
// through (a `WorkspaceRoots` carries them), and those ports' failures.
export {
  ConfigWriteFailed,
  Settings,
  StateReadFailed,
  StateWriteFailed,
  type ConfigProvider,
  type SettingsStores,
  type StateStore,
  type StoredSetting,
} from '@shared/config/settings';
export { Secrets, type PlatformSecrets } from '@platform/secrets';
export {
  AppSignals,
  emitAppSignal,
  type AppSignal,
  type AppSignalEvent,
  type AppSignalPayloads,
} from '@platform/appSignals';
// The process services a plugin's layer may read: the app's state store,
// the per-project settings stores, the global root's current values with
// each family a host or plugin declares (`ValueFamily`), and the tool
// catalog (enabled built-ins, plugin services and switches) with the
// context it hands a plugin, and the agent directories with the packaged
// resources root a plugin's bundled files ship under (the port is the root
// entry's).
export {
  AgentDirectories,
  AppState,
  type AppStateStore,
} from '@platform/interfaces';
export {
  GlobalValues,
  StateStores,
  type PluginContext,
} from '@platform/processRuntime';
export type { ValueFamily } from '@shared/session/valueFamily';
export type { CurrentValues } from '@shared/session/database';
export { ToolCatalog, type ToolCatalogShape } from '@tools/liveTools';
export { logFailure, withLogChannel } from '@logger/effectLog';
// One exclusive lane per key, for work that must run one at a time per key
// (one build per project, one edit per file), and the one lane every writer
// of a file shares with the harness's approved edits.
export {
  withPerKeyLane,
  type PerKeyLane,
  type PerKeyLanes,
} from '@utils/core/perKeyQueue';
export { withFileWriteLane } from '@utils/files/fileWriteLane';
export { SESSION_CLOSE_DEADLINE_MS } from '@agent/runtime/sessionEventsLayer';
// What `ChildRuns` launches: an external process's child, with the one
// turn it runs.
export type {
  ProcessChildLaunch,
  ProcessReport,
  ProcessTurn,
} from '@agent/runtime/processRun';
// What a process child's turn delivers to its parent, typed.
export type { ChildRunDelivery } from '@shared/schemas';
// A run's input as a plugin sends it, and how the send landed.
export type {
  RunInbox,
  SubmitFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
export type { InboxItem } from '@agent/followUp/Inbox';
// A blob a draft stores or links by digest, as a call's request and an
// inbox item carry it.
export type { DraftBlob } from '@shared/session/historyTurns';
export type { CellError, RunHistoryRefused } from '@shared/session/runHistory';
export type { RunHistoryInconsistent } from '@shared/session/runState';
export type { StepRoot } from '@utils/files/externalRoots';
// The run a plugin's tool reads (`ToolRun`) and the pieces it names: its
// policy, trace and stages, model binding and run files.
export type { ToolRun } from '@tools/core/ToolTypes';
export type { ToolPolicy } from '@agent/runtime/run/AgentRun';
// Renders a prompt template (Nunjucks) with its variables.
export { PromptRenderFailed, renderPrompt } from '@agent/prompt/promptRender';
export type {
  AgentTrace,
  StreamHandle,
  ToolCardHandle,
} from '@agent/trace/AgentTrace';
export type { LogOptions } from '@shared/schemas/logPayload';
export type { ProcessOutputStream } from '@shared/schemas/traceEvent';
export type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
export type {
  ModelRetryGate,
  RoutePolicy,
} from '@agent/runtime/ModelRetryGate';
// A run's directory under a storage root, one entry of it read without
// following a link, and where a path a run reads from lives (run storage
// keeps its run's provenance).
export {
  runDirUnder,
  runEntryUnder,
  type RunStorageEntry,
  sourceLocationUnder,
} from '@common/storage/storageLayout';
// A path's `FileLocation` against the workspace root a caller holds: workspace
// or external.
export { pathToLocationIn } from '@common/storage/fileLocation';
export { HostCapabilities } from '@agent/runtime/agentToolResolution';
// The harness's retry policy: which HTTP statuses are worth retrying, the
// randomized exponential backoff `Schedule` its fetches retry on, and the
// capped, jittered delay a caller that sleeps for itself waits.
export {
  jitteredExponentialBackoffMs,
  randomizedExponentialBackoff,
} from '@utils/core/backoffSchedule';
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
