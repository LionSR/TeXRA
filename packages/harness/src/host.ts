/**
 * `@texra-ai/harness/host`: what a full application host composes beyond
 * the root entry. TeXRA's editor extension, desktop app and terminal app
 * read it; an embedder that runs agents from a program needs none of it.
 *
 * It holds the process layer a host builds once (`processLayer`), the
 * services a host serves its views from (agent catalog, skills, installed
 * plugins, model options, tool availability, storage maintenance), the
 * presenters of the root's `HostInteractions`, and the helpers the hosts
 * share for files, errors and logs.
 *
 * No signature on another entry names a type that only this one exports,
 * with one exception: the requirement unions `RunServices` and
 * `PlatformServices`, which list the services a host process serves and
 * which a plugin passes through without naming a member.
 *
 * No stability promise: names move here when they leave the root entry and
 * leave when the hosts stop needing them.
 */

// The process every host composes: one `processLayer`, built once.
export { processLayer } from './effect/processLayer.js';
// A run's trace and its activation's view read back from a session's rows,
// for a session whose runs run elsewhere (a window over the background
// service).
export { replayTrace } from '@controllers/session/runTrace';
// What launches a program as a run of its own: the config a host or an
// app's command starts it with, and the programs there are to start now
// (the plugin list's and the installed plugins').
export {
  programLaunch,
  ProgramNotRegistered,
  programsNow,
} from '@agent/runtime/programRun';
export {
  activationView,
  type ActivationViewSource,
} from './effect/runHandle.js';
export {
  formatConversationMessage,
  type ConversationFormatOptions,
} from '@shared/transcript/conversationFormat';
// The process the hosts compose: one `processLayer` for every host.
export type { ProcessLayerOptions } from './effect/processLayer.js';
export type { ProcessServicesOptions } from '@controllers/session/sessionLayer';
// A project's `.env` over the process environment, for a one-project host.
export { workspaceEnvironmentLayer } from '@platform/defaults/nodeServices';
export {
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
} from './effect/processLayer.js';
export type { PlatformServices } from '@platform/processRuntime';
// The run function a host callback starts Effect work with, owned by a scope.
export { scopedFork, type ScopedFork } from '@platform/processRuntime';
// What a run's program requires of the process, beneath `ProcessServices`.
export type { RunServices } from '@agent/runtime/ToolServices';
export type { AgentCatalogServices } from '@agent/index/agentEntry';
// The agent catalog: reads, launch resolution, custom copies, the workspace's
// selection, and the agent directories a host serves it.
export {
  AgentCatalog,
  AgentCatalogLoadError,
  AgentNotFound,
  type AgentCatalogShape,
  type WorkspaceAgents,
  type WorkspaceAgentsStores,
} from '@agent/index/agentCatalog';
export { agentToolNames, type AgentEntry } from '@agent/index/agentEntry';
export type {
  WorkspaceAgentsController,
  WorkspaceAgentsControllerDeps,
  WorkspaceAgentsEntry,
} from '@agent/workspaceAgents/WorkspaceAgentsController';
export type { AgentDelegationScope } from '@shared/schemas';
export {
  AgentCustomizeRefused,
  AgentDirectoryService,
  CUSTOM_AGENT_DIR_KEY,
  readCustomAgentDir,
  type AgentCustomization,
  type AgentDirectoryServiceOptions,
} from '@agent/index/AgentDirectoryService';
export { BUNDLED_AGENTS_DIRECTORY } from '@agent/index/BundledAgentDirectories';
export { registerCustomAgentRoot } from '@tools/agentCatalogFollower';
// Storage maintenance under a storage root (the process's stores, which
// plugins read too, are on `./plugins`).
export {
  deleteStorageInventory,
  readStorageInventory,
  type StorageInventory,
} from '@controllers/session/projectDatabase';
// Follow-up delivery helpers hosts share.
export { presentFollowUpResult } from '@agent/followUp/ToolUseFollowUp';
// A host's presentation of the notices the root entry types
// (`HostInteractions`, `Notices`): a window's own presenter, the emit
// handlers (one per event), and a failed run's presentation, with the notice
// a refused launch carries.
export {
  presenterOn,
  presentRunFailure,
} from '@agent/runtime/HostInteractions';
// One program per pending request a host follows, while the view lists it.
export { followPendingRequests } from './effect/requestAnswerer.js';
export type { PresentationEventHandlers } from '@agent/runtime/runtimePresentationEvents';
// App-lifecycle signals as hosts and the app follow them (the hub and its
// signals are on `./plugins`).
export {
  appSignalStream,
  subscribeAppSignal,
  onAppSignal,
} from '@platform/appSignals';
// Model access outside a run: the user's key and endpoint (transcription).
export { ownKeyCredential } from '@agent/runtime/modelAccess/credentials';
// The canned model a package-validation build provides beneath the process.
export { ValidationModel } from '@agent/runtime/modelAccess/routeDecision';
// The models a host offers: each visible model's option, the enabled list and
// its writer, run-model precedence, the reasoning policy, the helper model.
export {
  getEnabledModels,
  MODEL_SELECTION_KEY,
  readModelOptions,
  setModelEnabled,
  type ModelVerdict,
} from '@model/computeModelOptions';
export {
  decideRunModel,
  type RunModelCandidate,
  type RunModelDecision,
  type RunModelDecisionReason,
} from '@model/runModelDecision';
export { SubscriptionPreference } from '@model/subscriptionAccess';
export {
  REASONING_LEVELS_KEY,
  type RouteReasoning,
  type SentReasoning,
} from '@model/reasoningLevel';
export { helperCall, type HelperPrompt } from '@agent/runtime/helperModel';
// The process's retry gate every model call (a helper call's too) waits on.
export type { RouteRetries } from '@agent/runtime/ModelRetryGate';
// Who a helper call's usage is billed to, and why a model call can fail.
export type { UsageAttribution } from '@agent/runtime/run/pricing';
export type { CallFailure } from '@agent/runtime/modelAccess/failureInfo';
export { getHelperModelName } from '@agent/runtime/helperModelName';
// Where every model call's usage goes, and the entry a sender ships.
export {
  UsageLog,
  UsageLogEntrySchema,
  type UsageLogEntry,
} from '@shared/usageLog';
// The layers of the rooted file systems plugins read (`./plugins`), for a
// host that reads them outside a run.
export { sessionFsLayer, withSessionFs } from '@platform/rootedFs';
// The user's MCP servers: their config file, and a namespaced tool's server.
export { readMcpConfig } from '@tools/mcp/mcpConfig';
export { mcpConfigPathOf } from '@common/plugins/mcpServers';
export type { McpServerConfig } from '@common/plugins/mcpServers';
// The skills a session's roots discover (the settings inventory, the enabled
// ones a person activates) with their issues.
export { Skills, type SkillRoots } from '@skills/runtimeSkills';
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
// Failures as hosts and plugins read them: the agent error, a predicate, and
// a failure's plain words with a model call's verdict.
export { AgentError, RouteUnavailable } from '@common/errors/agentErrors';
export { isModuleNotFoundError } from '@common/errors/errorPredicates';
export { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
export type { ProviderError } from '@shared/schemas';
// The office formats the Read tool converts to text.
export { OFFICE_EXTENSIONS } from '@utils/files/mimeUtils';
// Which external tools this machine has, as plugins' `availability` probes
// answered; a host reads it and asks for a refresh.
export {
  ToolAvailability,
  type AvailabilityResults,
  type ExternalToolCheckResult,
} from '@tools/toolAvailabilityService';
// The write path's redaction, for host text shown outside it.
export {
  formatFatalErrorDetail,
  redactDiagnostics,
  redactSecrets,
} from '@logger/redaction';
