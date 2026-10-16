/**
 * `@texra-ai/harness` — the SDK's surface, stated in Effect.
 *
 * The services below are where every decision this package makes is
 * stated: which level is a run's first, when its transcript interest
 * changes, when its drain ends, which failure wins. Nothing in the package
 * calls `Effect.runPromise`, `runSync`, or `runFork`: a Promise-land
 * embedder runs `Effect.runPromise(program)` at its own entry point.
 *
 * This module is the package's public surface and is documented as one
 * (packages/harness/README.md); it is the one barrel the "no convenience
 * barrels" rule does not apply to.
 *
 * The root entry used to render these services as Promises and
 * AsyncIterables, the boundary the Effect migration's rule R1 names
 * (`2026-08-26-effect-4-runtime-migration.md`,
 * §7 R1, boundary kind 3: the published SDK speaks Promises). That ruling is
 * superseded (2026-09-21): `effect` is a mandatory exact-pin peer dependency
 * of the whole package, the package has no external consumers, and TeXRA 1.0
 * keeps no parallel surfaces.
 */

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

// The failures the surface names.
export {
  AgentNotFound,
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
export { hasErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
export { escapeText } from '@shared/utils/xmlEscape';

// The payloads, as the runtime defines them.
export { qualifyAggregateId } from '@shared/schemas';
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
  IToolRegistry,
  ToolContextShape,
  ToolEnv,
  ToolGuard,
} from '@agent/core/tools/ToolTypes';
export type { SettingHost } from '@shared/state/stateSettings';
export { MapToolRegistry, ToolContext } from '@agent/core/tools/ToolTypes';
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
  Disposable,
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
  type RunModelDecisionReason,
} from '@model/runModelDecision';
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
// Which external tools this machine has, as plugins' `availability` probes
// answered; a host reads it and asks for a refresh.
export { ToolAvailability } from '@tools/toolAvailabilityService';
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
// The harness's own state keys, and the row shape a settings UI lists.
export { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
export type { SurfacedSettingEntry } from '@shared/state/stateSettings';
