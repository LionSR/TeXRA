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
 *   [`descendantRuns`](#descendantruns), [`runActionRefusal`](#runactionrefusal)).
 * - **Commands & approvals**: [`RuntimeRequestSchema`](#runtimerequestschema)
 *   ([`RuntimeRequest`](#runtimerequest)), [`RequestDecision`](#requestdecision),
 *   [`OutcomeSchema`](#outcomeschema), [`RequestErrorSchema`](#requesterrorschema),
 *   [`ApprovalPolicySchema`](#approvalpolicyschema), [`resolveBypass`](#resolvebypass).
 * - **Agent definitions & run outcomes**: [`AgentConfigSchema`](#agentconfigschema),
 *   [`InlinePersonaSchema`](#inlinepersonaschema), [`RunEndSchema`](#runendschema),
 *   [`RunIdSchema`](#runidschema), [`StartRequestSchema`](#startrequestschema).
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
export { DEFAULT_AGENT_MODEL } from '@shared/constants/defaultModels';
// The subscriptions a model call can route through, by provider id.
export {
  SUBSCRIPTION_AUTH_PROVIDERS,
  type SubscriptionAuthProvider,
} from '@shared/model/subscriptionAuth';
// Reads of a `SessionView` for a renderer: what needs a person, how busy
// the session is, where each run stands, what `acceptsFollowUp` reads.
export {
  acceptsFollowUp,
  isInterrupted,
  isUnreadable,
  isWorking,
  attentionOf,
  descendantRuns,
  needsUser,
  requestAnswerability,
  rollupOf,
  sessionActivity,
  SessionViewSchema,
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
// What a session store's reads answer with: an aggregate's state, a CLI
// input-history row, the refusals, and the notice of a store moved aside
// on open.
export type {
  AggregateState,
  DatabaseAggregateClosed,
  InputHistoryRecord,
  SessionStoreMovedAside,
} from '@shared/session/database';
// Where a run stands, the pair of `RunView` fields a renderer reads.
export type { RunStanding } from '@shared/session/runRowReads';
// A follow-up queued for a run, as its row holds it (`InboxItem.control`).
export type { QueuedFollowUp } from '@shared/session/runRows';
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
  ExternalFileLocation,
  FileListEntry,
  FileLocation,
  FollowUpContent,
  FollowUpSender,
  HookEvent,
  InlinePersona,
  HarnessInstructionKey,
  JsonValue,
  LoadedMediaMetadata,
  LocalRuntimeState,
  UnreadableRun,
  LogicalId,
  LogLevel,
  MediaAttachmentKind,
  MessageType,
  ModelAvailabilityKind,
  ModelBackend,
  NormalizedToolUse,
  OwnerId,
  RequestPayload,
  Persona,
  ProposalFileGroup,
  ProviderError,
  OpenFilePayload,
  RequestShowErrorPayload,
  RequestShowInstructionPayload,
  ResponseCut,
  ResumeRefusal,
  RunAction,
  RunId,
  RunIdentity,
  RunOutcome,
  RunPosition,
  RunStorageFileLocation,
  ScriptDeliverySummary,
  SessionEvent,
  SessionEventDraft,
  AgentNotFoundPayload,
  TaskGroup,
  TaskGroupStatus,
  ToolCallStatus,
  ToolCard,
  ToolDefinition,
  ToolEditContent,
  ToolEditRequest,
  ToolFact,
  ToolUseLog,
  UsageRoute,
  WorkspaceFileLocation,
} from '@shared/schemas';
export { ResumeRefusalSchema } from '@shared/schemas';
// The approval policy: its values, default, persisted key and tolerant
// parse, and the denial a run that may not ask reports.
export {
  APPROVAL_POLICIES,
  APPROVAL_POLICY_CONFIG_KEY,
  APPROVAL_POLICY_DEFAULT,
  APPROVAL_POLICY_NO_INPUT_DEFAULT,
  ApprovalPolicySchema,
  parseApprovalPolicy,
  type ApprovalPolicy,
  type HumanInputDecision,
  type RetryApprovalDecision,
} from '@shared/approvalPolicy';
// The approvals a run may skip, and how a run's own and inherited grants
// resolve against the policy.
export {
  APPROVAL_BYPASS_KINDS,
  launchPolicy,
  resolveBypass,
  runBypasses,
  type ApprovalBypassKind,
  type LaunchApproval,
  type ApprovalGrants,
  type ApprovalGrantSource,
} from '@shared/approvalBypassKind';
// A request a host sends a session, the outcome or the error class it is
// answered with, and a run's start as data.
export {
  Cancelled,
  OutcomeSchema,
  Rejected,
  RequestErrorSchema,
  RuntimeRequestSchema,
  StartRequestSchema,
  type RequestError,
  type RuntimeRequest,
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
  type TraceFactKind,
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
  type SettingsCatalog,
  type SettingStore,
  type StateSettingEntry,
} from '@shared/state/stateSettings';
// What a `ConfigProvider` (root) writes to and reads back per scope.
export type { ConfigInspection, ConfigTarget } from '@shared/config/settings';
export { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
// The providers with a custom-endpoint setting, and a provider's
// custom-endpoint key and China-region toggle, if it has them.
export {
  PROVIDER_ENDPOINT_STATE_ENTRIES,
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

// Agents, request payloads, harness setting keys, skills, and run outputs.
export {
  type ActiveSkillSourceScope,
  ActiveSkillSourceScopeSchema,
  AGENT_SKILLS_CONFIG_KEY,
  AGENT_SOURCE,
  AgentConfigSchema,
  agentFileName,
  agentKey,
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
  type AgentProposalRequest,
  type AgentScanIssue,
  AgentScanIssueSchema,
  AgentSourceSchema,
  type BashRequest,
  blocksCaller,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  type ContextStateData,
  CredentialSwitchSchema,
  DEFAULT_WORKFLOW_AGENT,
  type DiffStats,
  DiffStatsSchema,
  emptyRunEndOutput,
  fileLocationAddressPath,
  fileLocationDisplayPath,
  FileLocationSchema,
  fileLocationShortDisplayPath,
  // A fresh run id, for a caller that names a run before a session launches it.
  generateRunId,
  formatHunkLines,
  getProposalFileGroups,
  GOAL_MAX_COST_SETTING,
  GOAL_STRATEGY_SETTING,
  GoalResultSchema,
  InlinePersonaSchema,
  InstalledPluginSchema,
  HARNESS_INSTRUCTION_KEY,
  isEmptyUsage,
  isModelOptionAvailable,
  isPackagedAgentSource,
  isRunId,
  isPlainAgentIdentity,
  isTaskConfig,
  JsonValueSchema,
  type LaunchNotice,
  LaunchNoticeSchema,
  LineCountSchema,
  listingTypeOf,
  type McpToolOutput,
  MESSAGE_TYPES,
  MODEL_AVAILABILITY_STATUS,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelAvailabilityKindSchema,
  type NormalizedUsage,
  NullableFileFieldsSchema,
  type Plan,
  type PlanApprovalRequest,
  planOf,
  planSummaryLine,
  type PluginRequest,
  type RequestKind,
  type ProposalFileFields,
  qualifyAggregateId,
  recipeBlockOf,
  referencedAggregates,
  type RequestDecision,
  RequestShowErrorPayloadSchema,
  type RetryRequest,
  RUN_OUTCOME,
  type RunEndOutput,
  RunEndSchema,
  runIdentityDisplayName,
  runIdentityName,
  RunIdSchema,
  RunRecordFieldsSchema,
  RunOutcomeSchema,
  RunResultSchema,
  type ProcessExit,
  type RunResult,
  RunWorkspaceFileSchema,
  type RunWorkspaceFile,
  AgentRunListingEntrySchema,
  type AgentRunListingEntry,
  runStorageFilePath,
  type SkillDisplayIssue,
  SkillDisplayIssueSchema,
  type SkillDisplayItem,
  SkillDisplayItemSchema,
  SkillNameSchema,
  type StoredMedia,
  StoredMediaSchema,
  sumUsageStats,
  toJsonValue,
  type TokenUsageStats,
  TOOL_CALL_STATUS,
  type UserQuestionAnswers,
  UserQuestionAnswersSchema,
  type UserQuestionRequest,
  type UserQuestionPrompt,
  UserQuestionPromptSchema,
  type WorkspaceAgentsSelection,
  type WorktreeInfo,
  ToolDependencyStatusSchema,
  type ToolDependencyStatus,
  // The run grant a request offers, which every surface renders.
  offeredGrant,
} from '@shared/schemas';
