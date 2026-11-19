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
 * - **Commands & approvals**: [`RuntimeCommandSchema`](#runtimecommandschema)
 *   ([`RuntimeCommand`](#runtimecommand)), [`RequestDecision`](#requestdecision),
 *   [`OutcomeSchema`](#outcomeschema), [`RequestErrorSchema`](#requesterrorschema),
 *   [`ApprovalPolicySchema`](#approvalpolicyschema), [`resolveBypass`](#resolvebypass).
 * - **Agent definitions & run outcomes**: [`AgentConfigSchema`](#agentconfigschema),
 *   [`InlinePersonaSchema`](#inlinepersonaschema), [`RunEndSchema`](#runendschema),
 *   [`RunIdSchema`](#runidschema), [`StartRequestSchema`](#startrequestschema).
 * - **Settings & trace export**: [`settingsCatalog`](#settingscatalog),
 *   the harness's setting rows ([`SettingRow`](#settingrow), each a
 *   [`StateKey`](#statekey)), [`TraceDocumentSchema`](#tracedocumentschema).
 */
export type {
  AgentConfig,
  AgentConfigPayload,
} from '@shared/schemas/agentConfig';
// A run's saved record: an agent's config or a task's,
// and its JSON with the fields its category hides dropped.
export {
  serializeFilteredConfig,
  type RunRecord,
} from '@shared/schemas/runRecords';
// The subscriptions a model call can route through, by provider id.
export {
  SUBSCRIPTION_AUTH_PROVIDERS,
  SUBSCRIPTION_ROUTES,
  isSubscriptionAuthProvider,
  type SubscriptionAuthProvider,
} from '@shared/model/subscriptionAuth';
// Reads of a `SessionView` for a renderer: what needs a person, how busy
// the session is, where each run stands, what `acceptsFollowUp` reads.
export {
  acceptsFollowUp,
  isInterrupted,
  isLive,
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
  type PendingRequest,
  type RequestAnswerability,
  type RunView,
  type SessionTitleState,
  type SessionView,
  type TranscriptView,
} from '@shared/session/sessionView';
// Why a run no longer takes an action its `actions` once listed.
export { runActionRefusal } from '@shared/session/runActions';
// What makes the views read-only all the way down.
export type { ReadonlyDeep } from '@shared/session/readonlyDeep';
// What a session store's reads answer with: a CLI input-history row, the
// refusal of a closed aggregate, and the notice of a store moved aside on
// open.
export type {
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
  AttachedMemoryMiss,
  CatalogAgentSource,
  CompactionActivityData,
  CompactionActivityOutcome,
  ContextManagementData,
  DeclinableUsageRoute,
  DispatchFacts,
  DisplayRow,
  ExternalFileLocation,
  FileListEntry,
  FileLocation,
  FinishedToolResult,
  FollowUpSender,
  HookEvent,
  InlinePersona,
  HarnessInstructionKey,
  LoadedMediaMetadata,
  LocalRuntimeState,
  LogLevel,
  MediaAttachmentKind,
  MessageType,
  ModelFailure,
  ModelAvailabilityKind,
  ModelBackend,
  NormalizedToolUse,
  RequestPayload,
  Persona,
  ProposalFileGroup,
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
  SessionRow,
  SessionRowDraft,
  AgentNotFoundPayload,
  Stage,
  ToolCallLog,
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
// Default a schema field to a plain constant when it decodes from an absent
// or `undefined` value, without the `Effect.succeed` ceremony.
export { decodingDefault, decodingDefaultType } from '@shared/schemas';
// The approval policy: its values, defaults, schema and tolerant parse.
export {
  APPROVAL_POLICIES,
  APPROVAL_POLICY_DEFAULT,
  APPROVAL_POLICY_NO_INPUT_DEFAULT,
  ApprovalPolicySchema,
  parseApprovalPolicy,
  type ApprovalPolicy,
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
  RunActive,
  Unavailable,
  RuntimeCommandSchema,
  StartRequestSchema,
  type RequestError,
  type RuntimeCommand,
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
  causeChain,
  ensureError,
  extractErrorMessage,
  formatError,
  toErrorMessage,
} from '@utils/errors/errorMessage';
// One node of a stored conversation, as `records(runId).readConversation`
// answers it and an export's format reads it.
export { ExportNodeSchema, type ExportNode } from '@shared/schemas/exportNode';
// A trace event by its row type: the members of the root's `AgentEvent`.
export type { TraceRow } from '@shared/session/agentEvent';
// The owner of a session row: a run, the session, or a plugin's key.
export type { AggregateId } from '@shared/schemas';
// An exported run, as a static viewer parses it back.
export {
  AssembleTraceResultSchema,
  readTraceFacts,
  TraceDocumentSchema,
  TraceMissingSchema,
  type AssembleTraceResult,
  type TraceDocument,
  type TraceFactKind,
} from '@shared/schemas/traceDocument';
// Path basics that hold in a browser: forward slashes, a path's base name,
// its base name without the extension, and a case-free extension check.
export {
  getBasename,
  getFileStem,
  hasExtension,
  normalizeFilePath,
} from '@utils/core/pathBasics';
// The setting rows a `ConfigProvider` resolves against (its `catalog`): the
// harness's own, which an app reads and writes through `Settings` and places
// in its settings UIs (a webview included), and the catalog an app builds
// from them and its own rows.
export {
  AGENT_SKILLS_ENABLED_SETTING,
  ALLOW_ORCHESTRATOR_KILL_SETTING,
  APPROVAL_POLICY_SETTING,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  DISABLED_SKILL_SOURCES_SETTING,
  DISABLED_SKILLS_SETTING,
  GIT_AUTHOR_EMAIL_SETTING,
  GIT_AUTHOR_NAME_SETTING,
  GIT_MARK_COMMITS_SETTING,
  GIT_WORKTREE_SUPPORT_SETTING,
  GLM_CODING_PLAN_SETTING,
  GOAL_MAX_COST_SETTING,
  GOOGLE_INTERACTIONS_SERVER_STATE_SETTING,
  HELPER_MODEL_SETTING,
  KIMI_CODE_PREFER_SETTING,
  MEMORY_ENABLED_SETTING,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  OPENAI_FAST_TIER_SETTING,
  CHATGPT_PREFER_SUBSCRIPTION_SETTING,
  DEBUG_MODE_SETTING,
  GOAL_STRATEGY_SETTING,
  MAX_IMAGE_DIMENSION_SETTING,
  SAVE_MODEL_IO_SETTING,
  XAI_PREFER_SUBSCRIPTION_SETTING,
  settingsCatalog,
  TOOL_PATH_PROTECTION_SETTING,
  WEBSOCKET_OPENAI_SETTING,
  type HarnessRowKey,
  type SettingChoiceCopy,
  settingName,
  type SettingRow,
  type SettingsCatalog,
  type SettingStore,
  type StateKey,
} from '@shared/state/stateSettings';
// What a `ConfigProvider` (`./plugins`) writes to and reads back per scope.
export type { ConfigInspection, ConfigTarget } from '@shared/config/settings';
// The providers' custom-endpoint and China-region rows, and a provider's
// own, if it has them.
export {
  DASHSCOPE_REGION_SETTING,
  GLM_ENDPOINT_SETTING,
  GLM_REGION_SETTING,
  MINIMAX_REGION_SETTING,
  MOONSHOT_REGION_SETTING,
  providerEndpointSetting,
  providerRegionSetting,
} from '@shared/state/providerSettings';

// Text primitives: grapheme-safe truncation (plain, whitespace-collapsed, or
// at the preview width), a clipped list, a text's content lines and their
// count, and
// control characters stripped so untrusted text cannot inject terminal
// escapes.
export {
  collapseWhitespace,
  countLines,
  DETAIL_SEPARATOR,
  FACT_SEPARATOR,
  formatClippedList,
  formatCompactDuration,
  formatCompactTokenCount,
  formatCostUsd,
  formatResetDuration,
  formatResultCount,
  joinFacts,
  pluralize,
  previewLabel,
  splitContentLines,
  stripControlCharacters,
  truncateSummary,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';
// A model call's failure as a run records it (its verdict), its plain
// words and a run end's, and the used-up plan it names, for an app that
// words it itself.
export {
  modelFailureMessage,
  runEndErrorMessage,
  usageLimitMessage,
  usedUpPlanOf,
  type RunEndError,
  type UsedUpPlan,
} from '@shared/schemas';
// Escaping for an XML or HTML attribute value and for element text.
export { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
// A schema failure as one dotted field path and message per leaf issue.
export {
  formatIssuesForDiagnostics,
  type FormattedIssue,
} from '@shared/schemas';

// Agents, request payloads, harness setting keys, skills, and run outputs.
export {
  ACTIVATED_SKILLS_MAX,
  type ActiveSkillSourceScope,
  ActiveSkillSourceScopeSchema,
  AGENT_FILE_EXTENSION,
  AGENT_SOURCE,
  AgentConfigSchema,
  agentFileName,
  agentKey,
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
  AgentNameSchema,
  type AgentProposalRequest,
  type AgentScanIssue,
  AgentScanIssueSchema,
  AgentSourceSchema,
  type BashRequest,
  type ContextStateData,
  CredentialSwitchSchema,
  type DiffStats,
  DiffStatsSchema,
  fileLocationAddressPath,
  fileLocationDisplayPath,
  FileLocationSchema,
  fileLocationShortDisplayPath,
  // A fresh run id, for a caller that names a run before a session launches it.
  generateRunId,
  formatHunkLines,
  getProposalFileGroups,
  GoalResultSchema,
  InlinePersonaSchema,
  InstalledPluginSchema,
  HARNESS_INSTRUCTION_KEY,
  isEmptyUsage,
  isModelOptionAvailable,
  isPackagedAgentSource,
  isRunId,
  isPlainAgentIdentity,
  programOf,
  LaunchNoticeSchema,
  NonNegativeIntSchema,
  listingTypeOf,
  type McpToolOutput,
  MESSAGE_TYPES,
  MODEL_AVAILABILITY_STATUS,
  ModelAvailabilityKindSchema,
  DeclinableUsageRouteSchema,
  type NormalizedUsage,
  FileFieldsSchema,
  type Plan,
  type PlanApprovalRequest,
  planOf,
  planSummaryLine,
  type RequestKind,
  // Who answers a request: a person, or the run grant that answers it.
  type AnsweredBy,
  type ProposalFileFields,
  factName,
  type FactName,
  referencedAggregates,
  replayInputs,
  type RequestDecision,
  RequestShowErrorPayloadSchema,
  type RetryRequest,
  RUN_OUTCOME,
  RunEndSchema,
  runIdentityDisplayName,
  runIdentityName,
  runNoun,
  NESTED_NOUNS,
  RunIdSchema,
  RunRecordFieldsSchema,
  RunOutcomeSchema,
  RunPositionSchema,
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
  type UserQuestionAnswers,
  UserQuestionAnswersSchema,
  type UserQuestionRequest,
  type UserQuestionPrompt,
  UserQuestionPromptSchema,
  type WorkspaceAgentsSelection,
  type WorktreeInfo,
  ToolDependencyStatusSchema,
  type ToolDependencyStatus,
  // The run grant a request offers: the one that answers it, which every
  // surface renders.
  offeredGrant,
} from '@shared/schemas';
