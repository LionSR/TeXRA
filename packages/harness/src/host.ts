/**
 * `@texra-ai/harness/host`: what a full application host composes beyond
 * the root entry. TeXRA's editor extension, desktop app and terminal app
 * read it; an embedder that runs agents from a program needs none of it.
 *
 * It holds the process layer a host builds once (`processLayer`), the
 * services a host serves its views from (agent catalog, settings, stores,
 * skills, installed plugins, model options, tool availability), the
 * presentation surface a host implements (`HostInteractions`), and the
 * helpers the hosts share for files, errors and logs.
 *
 * No stability promise: names move here when they leave the root entry and
 * leave when the hosts stop needing them.
 */

// The process every host composes: one `processLayer`, built once.
export { processLayer } from './effect/processLayer.js';
// A project's view read cold from its store, for a multi-project listing.
export { readSessionView } from '@controllers/session/readSessionView';
export type { RunRejection } from '@agent/runtime/runClassification';
export { ExportNodeSchema, type ExportNode } from '@agent/export/schemas';
export {
  formatConversationMessage,
  type ConversationFormatOptions,
} from '@agent/storage/conversationFormat';
export type { RunWorkspaceFile } from '@agent/storage/runWorkspaceFiles';
export type { AssembleTraceResult } from '@transcript/traceAssembler';
// What `SessionHost.emit` takes and answers: the notices a session's runs
// ask a host to present.
export type {
  AgentRuntimeEmitOptions,
  HostPresentation,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
// The process the hosts compose: one `processLayer` for every host.
export type { ProcessLayerOptions } from '@controllers/session/sessionLayer';
// A project's `.env` over the process environment, for a one-project host.
export { workspaceEnvironmentLayer } from '@platform/defaults/nodePlatform';
export {
  withProcessServices,
  type AgentCatalogServices,
  type PluginContext,
  type ProcessRuntime,
  type ProcessServices,
} from '@platform/processRuntime';
// The agent catalog: reads, launch resolution, custom copies, the workspace's
// selection, and the agent directories a host serves it.
export {
  AgentCatalog,
  AgentCatalogLoadError,
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
export * from '@common/teams/TeamPresets';
export * from '@common/teams/TeamPlan';
export type { AgentDelegationScope } from '@shared/schemas';
export {
  AgentCustomizeRefused,
  AgentDirectoryService,
  readCustomAgentDir,
  type AgentCustomization,
  type AgentDirectoryServiceOptions,
} from '@agent/index/AgentDirectoryService';
export { BUNDLED_AGENTS_DIRECTORY } from '@agent/index/BundledAgentDirectories';
export { registerCustomAgentRoot } from '@tools/agentCatalogFollower';
// The process's stores: the global root's current values, each family a
// host or plugin declares (`ValueFamily`), the per-project settings stores,
// and storage maintenance under a storage root.
export { GlobalValues, StateStores } from '@platform/processRuntime';
export type { ValueFamily } from '@shared/session/valueFamily';
export {
  DatabaseWriteFailed,
  type CurrentValues,
  type EventsRead,
} from '@shared/session/database';
export type { DraftBlob, WithBlobs } from '@shared/session/historyTurns';
export type { AppStateStore } from '@platform/interfaces';
export {
  deleteStorageInventory,
  readStorageInventory,
  type StorageInventory,
} from '@controllers/session/projectDatabase';
export { heldElsewhereBy } from '@shared/session/database';
// Follow-up delivery, error-presentation and prompt-escaping helpers hosts share.
export {
  describeFollowUpFailure,
  presentFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
export {
  attachErrorPresentationClaimed,
  hasErrorPresentationClaimed,
} from '@common/errors/sdkError/errorMetadata';
// A host's presentation surface: session and sessionless interactions, the
// emit handlers (one per event), and a failed run's presentation claim.
export {
  SessionHostInteractions,
  type HostInteractions,
} from '@agent/runtime/HostInteractions';
export type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
export { buildDiffHunks, type DiffHunks } from '@utils/text/unifiedDiff';
export type { PresentationEventHandlers } from '@agent/runtime/runtimePresentationEvents';
export { presentRunFailure } from '@agent/runtime/terminalResultToast';
// Which side of a trace event a run wrote.
export type { TraceArm } from '@agent/trace';
export type { SettingHost } from '@shared/state/stateSettings';
export type { AggregateId, SessionCloseReport } from '@shared/schemas';
// The platform's ports, their stores' failures, and the services plugins read.
export {
  AgentDirectories,
  AgentDirectoriesFailed,
  AppState,
  ConfigWriteFailed,
  StateReadFailed,
  StateWriteFailed,
  ToolMissingReporter,
  type AgentDirectoriesPort,
  type ConfigProvider,
  type StateStore,
  type ToolMissingHandler,
} from '@platform/interfaces';
export { Secrets, type PlatformSecrets } from '@platform/secrets';
// App-lifecycle signals: the process's hub, which `ProcessServices` serves,
// and what hosts and the app publish and follow on it.
export {
  AppSignals,
  appSignalStream,
  emitAppSignal,
  onAppSignal,
  type AppSignal,
  type AppSignalEvent,
  type AppSignalPayloads,
} from '@platform/appSignals';
// The budget a session close waits for its runs: a plugin's drain fits it.
export { SESSION_CLOSE_DEADLINE_MS } from '@agent/runtime/SessionHandle';
// Model access outside a run: the user's key and endpoint (transcription).
export { ownKeyCredential } from '@agent/runtime/modelAccess/credentials';
export type { RouteCredential } from '@agent/runtime/modelAccess/credentials';
// The models a host offers: each visible model's option, the enabled list and
// its writer, run-model precedence, the reasoning policy, the helper model.
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
export { SubscriptionPreference } from '@model/subscriptionAccess';
export type { RouteReasoning, SentReasoning } from '@model/reasoningLevel';
export { helperCall, type HelperPrompt } from '@agent/runtime/helperModel';
// The process's retry gate every model call (a helper call's too) waits on.
export type { RouteRetries } from '@agent/runtime/run/invocation';
// Who a helper call's usage is billed to, and why a model call can fail.
export type { UsageAttribution } from '@agent/runtime/run/pricing';
export type { CallFailure } from '@agent/runtime/modelAccess/failureInfo';
export { getHelperModelName } from '@agent/runtime/helperModelName';
// Where every model call's usage goes, and the entry a sender ships.
export { UsageLog, type UsageLogEntry } from '@shared/usageLog';
// What a used-up plan falls back to, as the retry copy names it.
export { quotaFallbackRouteFor } from '@shared/quotaFallbackRoutes';
// The rooted file systems plugins read, and their layers outside a run.
export {
  GlobalStorageFs,
  sessionFsLayer,
  StorageFs,
  withSessionFs,
  WorkspaceFs,
} from '@platform/rootedFs';
export type { RootedFileSystem } from '@utils/files/rootedFileSystem';
// A `FileLocation` by its root: workspace, run storage, external, or relative.
export {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
  pathToLocationIn,
} from '@utils/files/fileLocation';
// The user's MCP servers: their config file, and a namespaced tool's server.
export { mcpConfigPathOf, readMcpConfig } from '@tools/mcp/mcpConfig';
export type { McpServerConfig } from '@common/plugins/mcpServers';
export { mcpServerOfToolName } from '@tools/mcp/mcpServer';
// The skills a session's roots discover (the settings inventory, the enabled
// ones a person activates) with their issues, and a host's skill sources and
// source options.
export {
  Skills,
  type EnabledSkill,
  type SkillRoots,
} from '@skills/runtimeSkills';
export type { HostSkillOptions } from '@platform/processRuntime';
export type { SkillSourceOptions } from '@skills/skillSources';
export type {
  SkillIssueCode,
  SkillIssueSeverity,
  SkillLoadIssue,
} from '@skills/skillLoader';
// The Claude Code and Codex plugins installed under a storage root: their
// operations (enable asks for trust), what loads now, and their refusals.
export {
  InstalledPlugins,
  type PluginOrigin,
  type PluginUpdate,
} from '@common/plugins/installedPlugins';
export type { PluginEnv } from '@common/plugins/installRecord';
export {
  PluginError,
  PluginRequestError,
} from '@common/plugins/pluginManifest';
export type { PluginListing, PluginReview } from '@common/plugins/pluginTrust';
export type { ConfiguredHook } from '@common/plugins/hookConfig';
export type { InstalledPlugin } from '@shared/schemas';
// The files a run left in its storage directory, under a session's storage
// (the executions tool's listing, for a host that shows it outside a run).
export {
  listRunGeneratedFiles,
  type RunGeneratedFile,
} from '@tools/executions/runGeneratedFiles';
// Failures as hosts and plugins read them: the agent error, predicates, cause
// chain, abort, provider message (`toErrorMessage` is in `./schemas`).
export { AgentError, RouteUnavailable } from '@common/errors/agentErrors';
export {
  agentErrorPresentation,
  type AgentErrorKind,
  type AgentErrorPresentation,
} from '@common/errors/agentErrorClassification';
export { causeChain } from '@utils/errors/errorMessage';
export {
  isFileNotFoundError,
  isModuleNotFoundError,
  isNotADirectoryError,
  isUserAbort,
} from '@common/errors/errorPredicates';
export { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
// Platform path containment, segments, POSIX form, case-free extension check.
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
// The tool catalog: enabled built-ins, plugin services, switches and their seed.
export { ToolCatalog, type ToolCatalogShape } from '@tools/liveTools';
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
// The write path's redaction, for host text shown outside it.
export { formatFatalErrorDetail, redactSecrets } from '@logger/redaction';
// Every read and write of a catalog setting, against the stores a caller
// holds (a session's roots), and the typed read of a non-catalog state key.
export {
  Settings,
  type SettingsStores,
  type StoredSetting,
} from '@shared/config/settings';
