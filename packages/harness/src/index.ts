/**
 * `@texra-ai/harness` — the SDK's surface, stated in Effect.
 *
 * The services below are where every decision this package makes is
 * stated: which level is a run's first, when its transcript interest
 * changes, when its drain ends, which failure wins. Nothing in the package
 * calls `Effect.runPromise`, `runSync`, or `runFork`: a Promise-land
 * embedder runs `Effect.runPromise(program)` at its own entry point.
 *
 * This module is the package's public surface, documented in the package
 * README. `effect` is a peer dependency: the surface is Effect services, not
 * Promises.
 */
// The one barrel the "no convenience barrels" rule does not apply to.

// The services and their layer. `Sessions.layer({ platform, plugins })` is
// an embedder's way in: the process and its sessions live for that layer's
// scope, so nothing is held without a scope to end it.
export type { AgentPlatform, Composition } from './effect/sessions.js';
export type { Plugin } from '@tools/plugins';
export { Sessions, processLayer } from './effect/processLayer.js';
export type {
  ApprovalHandler,
  OpenOptions,
  PendingRequest,
  ResumeInput,
  Run,
  Session,
  SessionHost,
  SessionView,
  StartInput,
  RunView,
  TranscriptView,
} from './effect/sessions.js';
export type { InlinePersona } from '@shared/schemas';
// What `SessionHost.emit` takes and answers: the notices a session's runs
// ask a host to present.
export type {
  HostPresentation,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';

// The process the hosts compose and the session owner it serves: one
// `processLayer` for every TeXRA host and for `Sessions.layer` above.
export { SessionOwner } from '@platform/processRuntime';
export type { ProcessLayerOptions } from '@controllers/session/sessionLayer';
// A project's `.env` over the process environment, for a host surface that
// serves one project (the desktop's), as each run reads it.
export { workspaceEnvironmentLayer } from '@platform/defaults/nodePlatform';
export {
  withForkFailureReporting,
  withProcessServices,
  type AgentCatalogServices,
  type PluginContext,
  type ProcessRuntime,
  type ProcessServices,
} from '@platform/processRuntime';

// The process's agent catalog: its reads, launch resolution and custom
// copies, the workspace's agent selection over it, and the agent
// directories a host serves it (bundled agents under its packaged
// resources' `BUNDLED_AGENTS_DIRECTORY`).
export {
  AgentCatalog,
  AgentCatalogLoadError,
  AgentNotFound,
  type AgentCatalogShape,
  type WorkspaceAgentsStores,
} from '@agent/index/agentCatalog';
export type { AgentEntry } from '@agent/index/agentEntry';
export {
  InvalidAgentTeamError,
  type WorkspaceAgentsController,
  type WorkspaceAgentsControllerDeps,
  type WorkspaceAgentsEntry,
} from '@agent/workspaceAgents/WorkspaceAgentsController';
export type { TeamPreset } from '@common/teams/TeamPresets';
export type { TeamCatalogAgent, TeamRunPlan } from '@common/teams/TeamPlan';
export type {
  AgentDelegationScope,
  AgentModePreset,
  AgentScanIssue,
} from '@shared/schemas';
export {
  AgentCustomizeRefused,
  AgentDirectoryService,
  readCustomAgentDir,
  type AgentCustomization,
  type AgentDirectoryServiceOptions,
} from '@agent/index/AgentDirectoryService';
export { BUNDLED_AGENTS_DIRECTORY } from '@agent/index/BundledAgentDirectories';
// The process's stores: the global root's current values, each family a
// host or plugin declares (`ValueFamily`), the per-project settings stores,
// and storage maintenance under a storage root.
export { GlobalValues, StateStores } from '@platform/processRuntime';
export type { ValueFamily } from '@shared/session/valueFamily';
export {
  DatabaseWriteFailed,
  type CurrentValues,
} from '@shared/session/database';
export type { AppStateStore } from '@platform/interfaces';
export {
  deleteStorageInventory,
  readStorageInventory,
  type StorageInventory,
} from '@controllers/session/projectDatabase';

// The failures the surface names.
export {
  PluginsRefused,
  ResumeRefused,
  RunFailure,
  ToolsRefused,
  TraceUnavailable,
} from './effect/errors.js';
export type { LaunchError } from './effect/errors.js';
export {
  DatabaseOpenFailed,
  DatabaseReadFailed,
  SessionOptionsConflict,
} from '@shared/session/database';
export type { SessionOpenError } from '@shared/session/database';

// Follow-up delivery, error-presentation and prompt-escaping helpers hosts share.
export {
  describeFollowUpFailure,
  presentFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
export {
  attachErrorPresentationClaimed,
  hasErrorPresentationClaimed,
} from '@common/errors/sdkError/errorMetadata';
// A host's presentation surface: what a session presents through, the
// `SessionHostInteractions` a host with no session of its own presents
// through, a host's emit handlers (one per presentation event), and a failed
// run's presentation, which marks it presented.
export {
  SessionHostInteractions,
  type HostInteractions,
} from '@agent/runtime/HostInteractions';
export type { PresentationEventHandlers } from '@agent/runtime/runtimePresentationEvents';
export { presentRunFailure } from '@agent/runtime/terminalResultToast';
export { escapeText } from '@shared/utils/xmlEscape';

// The payloads, as the runtime defines them.
export type { AgentEvent } from '@agent/trace';

// `RunEndResult` is deliberately sourced from its own module rather than
// from the `@agent/runtime` barrel. It appears in this package's PUBLIC
// declarations, and declaration emit follows whichever module a public type
// comes from: taking it from the barrel pulls the barrel's whole `.d.ts`
// graph — model handlers included — into the published type surface, which
// trips the provider-type leak check in `scripts/validate-artifacts.mjs`
// (`@anthropic-ai/sdk`).
export type { RunEndResult } from '@agent/runtime/RunEndResult';
export type {
  CallRequests,
  ITool,
  ToolContextShape,
  ToolEnv,
  ToolGuard,
} from '@agent/core/tools/ToolTypes';
export type { SettingHost } from '@shared/state/stateSettings';
export { ToolContext } from '@agent/core/tools/ToolTypes';
export { defineTool } from '@tools/core/definition';
export type { DefinedTool } from '@tools/core/definition';
export type {
  AggregateId,
  RequestDecision,
  RunId,
  SessionCloseReport,
  TranscriptSubscription,
} from '@shared/schemas';
// A request's refusals, as `Session.request` fails with them.
export {
  Cancelled,
  HostRequestFailure,
  Internal,
  isRequestRefusal,
  NotOwner,
  Rejected,
  Unavailable,
} from '@shared/session/requestErrors';
export type {
  RequestError,
  RequestRefusal,
} from '@shared/session/requestErrors';
export type {
  Outcome,
  RunStopReason,
  RuntimeRequest,
  ToolEditContent,
} from '@shared/session/runtimeRequest';

// The platform's ports: what an `AgentPlatform` implements, the failures its
// stores answer with, and the services a plugin's code reads them as.
export type {
  AgentDirectoriesPort,
  ConfigProvider,
  StateStore,
  ToolMissingHandler,
} from '@platform/interfaces';
export {
  AgentDirectories,
  AgentDirectoriesFailed,
  AppState,
  ConfigWriteFailed,
  StateReadFailed,
  StateWriteFailed,
  ToolMissingReporter,
} from '@platform/interfaces';
export type { PlatformSecrets } from '@platform/secrets';
export { Secrets } from '@platform/secrets';
export type {
  LanguageModelAccessState,
  LanguageModelInfo,
  LanguageModelPort,
  LanguageModelReference,
} from '@platform/languageModel';
export {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
export type { WorkspaceRoots } from '@platform/workspaceRoots';

// What a plugin's `availability` answers with, and reads.
export type {
  ToolAvailabilityChecks,
  ToolProbeError,
  ToolProbeInputs,
  ToolProbeServices,
} from '@tools/toolProbes';

// The budget a session close waits for its runs: a plugin's drain fits it.
export { SESSION_CLOSE_DEADLINE_MS } from '@agent/runtime/SessionHandle';
// Model access a host request makes outside a run: the user's own key and
// the endpoint they set (audio transcription).
export { ownKeyCredential } from '@agent/runtime/modelAccess/credentials';
// The models a host offers: one read answers every visible model's option
// (availability, route, the plan paying, why it cannot run), beside the
// enabled list and its one writer, the precedence that picks a run's model,
// the one reasoning-level policy, and the helper model.
export {
  getEnabledModels,
  ModelHostFactUnreadable,
  readModelOptions,
  setModelEnabled,
  type ModelOption,
  type ModelOptionStores,
} from '@model/computeModelOptions';
export {
  decideRunModel,
  type RunModelCandidate,
  type RunModelDecision,
  type RunModelDecisionReason,
  type RunModelFallbackMode,
} from '@model/runModelDecision';
export type { CopilotModelRoute } from '@model/copilotRouting';
export {
  reasoningEffortOverrides,
  supportsReasoningLevel,
} from '@model/reasoningLevel';
export { helperCall, type HelperPrompt } from '@agent/runtime/helperModel';
// Who a helper call's usage is billed to, and why a model call can fail.
export type { UsageAttribution } from '@agent/runtime/run/pricing';
export type { CallFailure } from '@agent/runtime/modelAccess/failureInfo';
export { RouteUnavailable } from '@common/errors/agentErrors';
export { getHelperModelName } from '@agent/runtime/helperModelName';
// Where every model call's usage goes, and the entry a sender ships.
export { UsageLog, type UsageLogEntry } from '@shared/usageLog';
// What a used-up plan falls back to, as the retry copy names it.
export { quotaFallbackRouteFor } from '@shared/quotaFallbackRoutes';

// The rooted file systems a plugin's code reads (the workspace, the
// session's run storage, the global storage root), and the layers that
// serve them over a session's roots outside a run.
export {
  GlobalStorageFs,
  sessionFsLayer,
  StorageFs,
  withSessionFs,
  WorkspaceFs,
} from '@platform/rootedFs';
// A path as a `FileLocation` against the workspace root a caller holds.
export { pathToLocationIn } from '@utils/files/fileLocation';
// Path containment on the platform's own paths, a path's segments and its
// POSIX form, and an extension check that ignores case. (The browser-safe
// path basics are in `./schemas`.)
export {
  getPathSegments,
  hasExtension,
  isPathWithin,
  isStrictlyWithin,
  toPosixPath,
} from '@utils/core/pathCore';
// The office formats the Read tool converts to text.
export { OFFICE_EXTENSIONS } from '@utils/files/mimeUtils';
// One exclusive FIFO lane per key, for work that must run one at a time per
// key (a file, a project, a prompt queue).
export {
  withPerKeyLane,
  type PerKeyLane,
  type PerKeyLanes,
} from '@utils/core/perKeyQueue';
// Which external tools this machine has, as plugins' `availability` probes
// answered; a host reads it and asks for a refresh.
export {
  ToolAvailability,
  type AvailabilityResults,
  type ExternalToolCheckResult,
} from '@tools/toolAvailabilityService';
// The process's tool catalog: the built-in tools the switches leave on, a
// plugin's process services, and the switches themselves; and the switches'
// first-install seed.
export {
  ToolCatalog,
  type ToolCatalogOwner,
  type ToolCatalogShape,
} from '@tools/liveTools';
export { seedDisabledToolDefaults } from '@tools/toolAvailability';
// The harness's log output: where its entries go and how an entry reads.
export {
  entryChannel,
  entryMessage,
  LOG_CHANNEL,
  setLogSink,
  type LogEntry,
  type LogSink,
} from '@logger/logSink';
export { withLogChannel } from '@logger/effectLog';
// The redaction the write path applies, for a host surface that shows text
// outside it (a crash dialog, a log file read back, a result message).
export { formatFatalErrorDetail, redactSecrets } from '@logger/redaction';
// Every read and write of a catalog setting, against the stores a caller
// holds (a session's roots), and the typed read of a non-catalog state key.
export {
  Settings,
  type SettingsStores,
  type StoredSetting,
} from '@shared/config/settings';
