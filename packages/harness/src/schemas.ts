export { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
export type {
  AgentConfig,
  AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
// A run's saved record (`assembleTrace`'s): an agent's config or a task's,
// and its JSON with the fields its category hides dropped.
export type { RunRecord } from '@agent/core/definition/RunRecord';
export { serializeFilteredConfig } from '@tools/executions/configView';
export { InlinePersonaSchema } from '@shared/schemas';
export type { InlinePersona, Persona } from '@shared/schemas';
// The payloads `RuntimePresentationEventPayloads` (root) names, one per
// notice a session's runs ask a host to present.
export type {
  FileLocation,
  InstructionAction,
  RequestEnsureProgressViewPayload,
  RequestOpenFilePayload,
  RequestShowErrorPayload,
  RequestShowInstructionPayload,
  ShowAgentConfigBannerPayload,
} from '@shared/schemas';
export type { RunEndResult } from '@agent/runtime/RunEndResult';
export { DEFAULT_AGENT_MODEL } from '@shared/constants/defaultModels';
export {
  AgentSourceSchema,
  RunIdSchema,
  RUN_OUTCOME,
  RunOutcomeSchema,
} from '@shared/schemas';
// A fresh run id, for a caller that names a run before a session launches
// it (a service's task start).
export { generateRunId } from '@utils/core';
export type {
  AgentConfigInput,
  AgentSource,
  RunId,
  RunOutcome,
} from '@shared/schemas';
// Who an agent is: its source, the key a catalog names it by, and whether
// it ships with an installed package; and the actions an instruction offers.
export {
  AGENT_SOURCE,
  agentKey,
  INSTRUCTION_ACTION,
  isPackagedAgentSource,
} from '@shared/schemas';
// A session's events as a renderer reads them: the listing each belongs to,
// the aggregates it names, and a run's display name.
export {
  listingTypeOf,
  qualifyAggregateId,
  referencedAggregates,
  runIdentityDisplayName,
} from '@shared/schemas';
export type { DisplaySessionEvent } from '@shared/schemas';
// The card a plugin's tool states for its own call (an external agent's
// patch, thread or turn), in the section kinds every renderer paints.
export { ToolCardSchema } from '@shared/schemas';
export type { ToolCard } from '@shared/schemas';
// The route a request's usage is billed through: a subscription plan, or
// the user's API key.
export type { UsageRoute } from '@shared/schemas';
// Why a model option can or cannot run, as a picker shows it.
export type { ModelAvailabilityKind } from '@shared/schemas';
// Reads of a `SessionView` (root) for a renderer: what needs a person, how
// busy the session is, and where each run stands.
export {
  acceptsFollowUp,
  attentionOf,
  descendantRuns,
  isLiveRun,
  isWorkingRun,
  requestAnswerability,
  rollupOf,
  sessionActivity,
} from '@shared/session/sessionView';
export type {
  Attention,
  RequestAnswerability,
  SessionTitleState,
} from '@shared/session/sessionView';
// The views themselves, read-only all the way down (the root re-exports
// them), the request a run waits on, and what a host brings to
// `acceptsFollowUp`.
export type {
  PendingRequest,
  RunView,
  SessionView,
  TranscriptView,
} from '@shared/session/readonlyViews';
export type { FollowUpHost } from '@shared/session/sessionView';
// What makes the views read-only all the way down.
export type { ReadonlyDeep } from '@shared/session/readonlyDeep';
// What a session store's reads and claims answer with: an aggregate's claim
// and state, a deletion's mode, a CLI input-history row, and the refusals.
export type {
  AggregateClaim,
  AggregateState,
  DatabaseClaimError,
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DeletionMode,
  InputHistoryRecord,
} from '@shared/session/database';
// A follow-up queued for a run, as its row holds it (`InboxItem.control`).
export type { QueuedFollowUp } from '@shared/session/runRows';
// The plan a used-up subscription falls back to (`quotaFallbackRouteFor`).
export type {
  QuotaFallbackExhaustionReason,
  QuotaFallbackRoute,
} from '@shared/quotaFallbackRoutes';
// The data shapes the public signatures name: session events and their
// owners, run facts, tool definitions and results, log and transcript
// payloads, follow-ups and requests.
export type {
  AgentProposal,
  AggregateKind,
  AttachedMemoryMiss,
  CompactionActivityData,
  CompactionActivityOutcome,
  ContextManagementData,
  DeclinableUsageRoute,
  DispatchFacts,
  ErrorLogData,
  ExhaustionReason,
  FileListEntry,
  FollowUpContent,
  FollowUpSender,
  HookEvent,
  JsonValue,
  LoadedMediaMetadata,
  LocalRuntimeState,
  LogicalId,
  LogLevel,
  MediaAttachmentKind,
  MessageType,
  ModelBackend,
  NormalizedToolUse,
  OfferedTool,
  OwnerId,
  OwnerLiveness,
  PermissionPayload,
  ProposalFileGroup,
  RefusalDecision,
  ResultMeta,
  RunIdentity,
  ScriptDeliverySummary,
  SessionEvent,
  SessionEventDraft,
  ToolCallStatus,
  ToolDefinition,
  ToolEditPermission,
  ToolFact,
  ToolUseLog,
} from '@shared/schemas';
// Where a run's lifecycle status stands: in flight (running, or waiting for
// its next input), active, ended, or settled enough for its transcript.
export {
  RUN_STATUS_KEYS,
  type RunStatusKey,
} from '@shared/runs/runStatusDisplay';
export type {
  ExternalFileLocation,
  RunLifecycleStatus,
  RunPhase,
  RunStorageFileLocation,
  TaskGroup,
  TaskGroupStatus,
  UserFollowUpSupport,
  WorkspaceFileLocation,
} from '@shared/schemas';
export {
  isActivePhase,
  isInFlightPhase,
  isTerminalOutcomePhase,
  isTranscriptSettlementPhase,
} from '@shared/runs/runStatus';
// The approval policy: its values, default, persisted key and tolerant
// parse, and the denial a run that may not ask reports.
export {
  APPROVAL_POLICIES,
  APPROVAL_POLICY_CONFIG_KEY,
  APPROVAL_POLICY_DEFAULT,
  APPROVAL_POLICY_NO_INPUT_DEFAULT,
  approvalPolicyDenialMessage,
  ApprovalPolicySchema,
  parseApprovalPolicy,
  type ApprovalPolicy,
  type ApprovalPolicyDenial,
  type HumanInputDecision,
  type RetryApprovalDecision,
} from '@shared/approvalPolicy';
// The approvals a run may skip, and how a run's own and inherited grants
// resolve against the policy.
export {
  resolveBypass,
  runBypasses,
  stricterPolicy,
  type ApprovalBypassKind,
  type ApprovalGrants,
  type ApprovalGrantSource,
} from '@shared/approvalBypassKind';
// A request a host sends a session and the outcome it answers with.
export {
  OutcomeSchema,
  RuntimeRequestSchema,
  ToolEditContentSchema,
} from '@shared/session/runtimeRequest';
export type {
  RuntimeRequest,
  ToolEditContent,
} from '@shared/session/runtimeRequest';
// A memory as a memory list shows it.
export {
  MemoryViewItemSchema,
  type MemoryViewItem,
} from '@shared/tools/memoryView';
// A model's display name.
export { getModelLabel } from '@shared/model/modelLabel';
// Error messages, and JSON parsed without a throw.
export {
  ensureError,
  extractErrorMessage,
  formatError,
  toErrorMessage,
} from '@utils/errors/errorMessage';
export { parseJsonWith, safeParseJson } from '@common/parsing/safeParseJson';
// The goal plugin's row, as a renderer reads a run's goal from it.
export { goalStateOf, type GoalState } from '@shared/plugins/goal';
// An exported run (`assembleTrace`), as a static viewer parses it back.
export {
  readTraceFacts,
  TraceDocumentSchema,
  type TraceDocument,
  type TraceFactArm,
} from '@transcript/traceDocumentSchema';
// Path basics that hold in a browser: forward slashes, a path's base name,
// and its base name without the extension.
export { getBasename, getFileStem, normalizeFilePath } from '@utils/core';
// The setting rows a `ConfigProvider` resolves against (its `catalog`) and
// the harness's own state keys, as a settings UI (a webview included) builds
// its catalog from them and names the rows it renders.
export {
  configTreeRows,
  settingsCatalog,
  type ModelsTabSurface,
  type SettingsCatalog,
  type SettingStore,
  type SettingSurfaces,
  type SettingsViewSnapshot,
  type SettingsViewStateSettingEntry,
  type SettingWriteEffects,
  type StateSettingEntry,
  type SurfacedSettingEntry,
} from '@shared/state/stateSettings';
// What a `ConfigProvider` (root) writes to and reads back per scope.
export type { ConfigInspection, ConfigTarget } from '@platform/interfaces';
export { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';

// Text primitives: grapheme-safe truncation (plain, whitespace-collapsed, or
// at the preview width), a text's content lines and their count, and
// control characters stripped so untrusted text cannot inject terminal
// escapes.
export {
  countLines,
  previewLabel,
  splitContentLines,
  stripControlCharacters,
  truncateSummary,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';
