/**
 * Browser-safe Effect Schemas, derived types, and pure read helpers for
 * `@texra-ai/harness`.
 *
 * > **Guide:** Read [Views, Transcripts & Renderers](/api/views-and-transcripts)
 * > and [Durable Protocol & Recovery](/api/durable-protocol) for how views,
 * > runtime requests, and approval policies work.
 *
 * - **Session & run views**: [`SessionView`](#sessionview), [`RunView`](#runview),
 *   [`TranscriptView`](#transcriptview), [`PendingRequest`](#pendingrequest),
 *   and pure queries ([`acceptsFollowUp`](#acceptsfollowup),
 *   [`attentionOf`](#attentionof), [`sessionActivity`](#sessionactivity),
 *   [`isLiveRun`](#isliverun), [`isWorkingRun`](#isworkingrun),
 *   [`descendantRuns`](#descendantruns), [`runActionRefusal`](#runactionrefusal)).
 * - **Commands & approvals**: [`RuntimeRequestSchema`](#runtimerequestschema)
 *   ([`RuntimeRequest`](#runtimerequest)), [`RequestDecision`](#requestdecision),
 *   [`OutcomeSchema`](#outcomeschema), [`RequestErrorSchema`](#requesterrorschema),
 *   [`ApprovalPolicySchema`](#approvalpolicyschema), [`resolveBypass`](#resolvebypass).
 * - **Agent definitions & run outcomes**: [`AgentConfigSchema`](#agentconfigschema),
 *   [`InlinePersonaSchema`](#inlinepersonaschema), [`RunEndSchema`](#runendschema),
 *   [`RunEndResult`](#runendresult), [`RunIdSchema`](#runidschema),
 *   [`RunOutcomeSchema`](#runoutcomeschema).
 * - **Settings & trace export**: [`settingsCatalog`](#settingscatalog),
 *   [`configTreeRows`](#configtreerows), [`GlobalStateKey`](#globalstatekey),
 *   [`WorkspaceStateKey`](#workspacestatekey), [`TraceDocumentSchema`](#tracedocumentschema).
 */
export type {
  AgentConfig,
  AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
// A run's saved record (`assembleTrace`'s): an agent's config or a task's,
// and its JSON with the fields its category hides dropped.
export type { RunRecord } from '@agent/core/definition/RunRecord';
export { serializeFilteredConfig } from '@tools/executions/configView';
// `RunEndResult` comes from its own module so declaration emit does not pull
// the provider SDK types in (the leak check in `scripts/validate-artifacts.mjs`).
export type { RunEndResult } from '@agent/runtime/RunEndResult';
export { DEFAULT_AGENT_MODEL } from '@shared/constants/defaultModels';
// A fresh run id, for a caller that names a run before a session launches it.
export { generateRunId } from '@utils/core';
// The subscriptions a model call can route through, and each one's switch
// and sign-in names.
export {
  SUBSCRIPTION_AUTH_NAMES,
  SUBSCRIPTION_AUTH_PROVIDERS,
  type SubscriptionAuthProvider,
} from '@shared/model/subscriptionAuth';
// Reads of a `SessionView` for a renderer: what needs a person, how busy
// the session is, where each run stands, what `acceptsFollowUp` reads.
export {
  acceptsFollowUp,
  attentionOf,
  descendantRuns,
  isLiveRun,
  isWorkingRun,
  requestAnswerability,
  rollupOf,
  sessionActivity,
  type Attention,
  type RequestAnswerability,
  type SessionTitleState,
} from '@shared/session/sessionView';
// The views, read-only all the way down, and the request a run waits on.
export type {
  PendingRequest,
  RunView,
  SessionView,
  TranscriptView,
} from '@shared/session/readonlyViews';
// Why a run no longer takes an action its `actions` once listed.
export { runActionRefusal } from '@shared/session/runActions';
// What makes the views read-only all the way down.
export type { ReadonlyDeep } from '@shared/session/readonlyDeep';
// What a session store's reads and claims answer with: an aggregate's claim
// and state, a deletion's mode, a CLI input-history row, the refusals, and
// the notice of a store moved aside on open.
export type {
  AggregateClaim,
  AggregateState,
  DatabaseClaimError,
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DeletionMode,
  InputHistoryRecord,
  SessionStoreMovedAside,
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
  AgentConfigInput,
  AgentProposal,
  AgentSource,
  AggregateKind,
  AttachedMemoryMiss,
  CompactionActivityData,
  CompactionActivityOutcome,
  ContextManagementData,
  DeclinableUsageRoute,
  DispatchFacts,
  DisplaySessionEvent,
  ErrorLogData,
  ExhaustionReason,
  ExternalFileLocation,
  FileListEntry,
  FileLocation,
  FollowUpContent,
  FollowUpSender,
  HookEvent,
  InlinePersona,
  InstructionAction,
  JsonValue,
  LoadedMediaMetadata,
  LocalRuntimeState,
  LogicalId,
  LogLevel,
  MediaAttachmentKind,
  MessageType,
  ModelAvailabilityKind,
  ModelBackend,
  NormalizedToolUse,
  OfferedTool,
  OwnerId,
  OwnerLiveness,
  PermissionPayload,
  Persona,
  ProposalFileGroup,
  RequestEnsureProgressViewPayload,
  RequestOpenFilePayload,
  RequestShowErrorPayload,
  RequestShowInstructionPayload,
  ResultMeta,
  ResumeRefusal,
  RunAction,
  RunId,
  RunIdentity,
  RunLifecycleStatus,
  RunOutcome,
  RunPhase,
  RunStorageFileLocation,
  ScriptDeliverySummary,
  SessionEvent,
  SessionEventDraft,
  ShowAgentConfigBannerPayload,
  TaskGroup,
  TaskGroupStatus,
  ToolCallStatus,
  ToolCard,
  ToolDefinition,
  ToolEditPermission,
  ToolFact,
  ToolUseLog,
  UsageRoute,
  UserFollowUpSupport,
  WorkspaceFileLocation,
} from '@shared/schemas';
// Where a run's lifecycle status stands: in flight (running, or waiting for
// its next input), active, ended, or settled enough for its transcript.
export {
  RUN_STATUS_KEYS,
  type RunStatusKey,
} from '@shared/runs/runStatusDisplay';
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
// A request a host sends a session, the outcome or the error class it is
// answered with, and a tool edit's hunks as unified-diff lines.
export {
  Cancelled,
  formatHunkLines,
  Internal,
  Invalid,
  NotOwner,
  OutcomeSchema,
  Rejected,
  RequestErrorSchema,
  RuntimeRequestSchema,
  ToolEditContentSchema,
  Unavailable,
  type RequestError,
  type RuntimeRequest,
  type ToolEditContent,
} from '@shared/session/runtimeRequest';
// A memory as a memory list shows it.
export {
  MemoryViewItemSchema,
  type MemoryViewItem,
} from '@shared/tools/memoryView';
// A model's display name.
export { getModelLabel } from '@shared/model/modelLabel';
// Error messages.
export {
  ensureError,
  extractErrorMessage,
  formatError,
  toErrorMessage,
} from '@utils/errors/errorMessage';
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
// A provider's custom-endpoint key and China-region toggle, if it has them.
export {
  providerEndpointKey,
  providerRegionSetting,
} from '@shared/state/providerSettings';

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
// Escaping for an XML or HTML attribute value and for element text.
export { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

// Agents, request payloads, inquiry turns, harness setting keys, skills, and run outputs.
export {
  type ActiveSkillSourceScope,
  ActiveSkillSourceScopeSchema,
  AGENT_MODE_PRESETS,
  AGENT_SKILLS_CONFIG_KEY,
  AGENT_SOURCE,
  AgentConfigSchema,
  agentFileName,
  agentKey,
  agentKeyOf,
  agentMatchesIdentifier,
  type AgentModePreset,
  AgentModePresetSchema,
  agentName,
  type AgentOptionData,
  AgentOptionDataSchema,
  type AgentProposalPermission,
  type AgentScanIssue,
  AgentScanIssueSchema,
  AgentSourceSchema,
  type AnsweredInquiryTurn,
  BASH_APPROVAL_CONFIG_KEY,
  type BashPermission,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  type ContextStateData,
  CredentialSwitchSchema,
  DEFAULT_WORKFLOW_AGENT,
  type DiffStats,
  DiffStatsSchema,
  emptyRunEndOutput,
  type ExternalInquiryPermission,
  ExternalInquiryTurnRecordSchema,
  fileLocationAddressPath,
  fileLocationDisplayPath,
  FileLocationSchema,
  fileLocationShortDisplayPath,
  getProposalFileGroups,
  GOAL_MAX_COST_SETTING,
  InlinePersonaSchema,
  type InquiryThreadId,
  InquiryThreadIdSchema,
  InstalledPluginSchema,
  INSTRUCTION_ACTION,
  isEmptyUsage,
  isLoopDriven,
  isModelOptionAvailable,
  isPackagedAgentSource,
  isRunId,
  isTaskConfig,
  JsonValueSchema,
  LineCountSchema,
  listingTypeOf,
  type McpToolOutput,
  MESSAGE_TYPES,
  MODEL_AVAILABILITY_STATUS,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelAvailabilityFieldsSchema,
  type ModelOptionData,
  ModelOptionDataSchema,
  NullableFileFieldsSchema,
  type OpenInquiryTurn,
  ownerIdentity,
  parseAgentModePresets,
  type Plan,
  type PlanApprovalPermission,
  planSummaryLine,
  type ProgressPermissionKind,
  type ProposalFileFields,
  qualifyAggregateId,
  recipeBlockOf,
  referencedAggregates,
  type RequestDecision,
  requestParksItsCaller,
  RESUME_ON_OPEN_SETTING,
  type RetryPermission,
  RUN_LIFECYCLE_READY,
  RUN_OUTCOME,
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunEndOutput,
  RunEndSchema,
  runIdentityDisplayName,
  runIdentityName,
  RunIdSchema,
  RunOutcomeSchema,
  RunRecordFieldsSchema,
  runStorageFilePath,
  type SkillDisplayIssue,
  SkillDisplayIssueSchema,
  type SkillDisplayItem,
  SkillDisplayItemSchema,
  SkillNameSchema,
  STARTER_AGENT_MODE_PRESET,
  sumUsageStats,
  type TeamOptionData,
  TeamOptionDataSchema,
  toJsonValue,
  type TokenUsageStats,
  TOOL_CALL_STATUS,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
  ToolCardSchema,
  ToolEditPermissionSchema,
  type UserQuestionAnswers,
  UserQuestionAnswersSchema,
  type UserQuestionPermission,
  type UserQuestionPrompt,
  UserQuestionPromptSchema,
  type WorkspaceAgentsSelection,
  type WorktreeInfo,
} from '@shared/schemas';
