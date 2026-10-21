// What a renderer paints a session's transcript from, browser-safe like
// `./schemas`: the view folded from a transport, the rows a `TranscriptView`
// (`./schemas`) holds, and the projections every host derives from them.

// A session's view across a process boundary: the fold over the inputs the
// caller's transport serves.
export { RemoteSessionView } from '@controllers/session/SessionView';
export { SessionInputs } from '@shared/session/sessionInputs';
export {
  CommitOrdinalSchema,
  DisplaySessionEventSchema,
  ExistenceReconciliationSchema,
  FoldEventSchema,
  LocalRuntimeStateSchema,
  TextChunkSchema,
  TranscriptSubscriptionSchema,
  type CommitOrdinal,
  type ExistenceReconciliation,
  type FoldInput,
  type ResumeBlocker,
  type TextChunk,
  type TranscriptSubscription,
} from '@shared/schemas';
// The runtime a view folds on: fork failures reported, and the redacting
// log sink in place of the console logger.
export {
  viewDiagnosticsLayer,
  withForkFailureReporting,
} from '@platform/processRuntime';

// The rows: one kind each, the headline a row is listed by, and the
// untruncated text a host elides to fit.
export { rowHeadline } from '@shared/transcript/transcriptRow';
export type {
  CompactionActivityRow,
  ContextManagementRow,
  ErrorRow,
  ErrorRowDetail,
  FileListRow,
  LoadedMediaRef,
  LogRow,
  ProgressStatusRow,
  StatItem,
  StreamingTextRow,
  ToolCallFacts,
  ToolRow,
  TranscriptRow,
  TranscriptRowBase,
  TranscriptRowKind,
  UserRow,
  WebSearchRow,
} from '@shared/transcript/transcriptRow';
export {
  elideText,
  transcriptText,
  type ElidedText,
  type PayloadLanguage,
  type TextBudget,
  type TranscriptText,
} from '@shared/transcript/transcriptText';
// A tool row's sections, and how a tool's name reads: its kind, its
// display key, and an MCP call's server and tool.
export type {
  ToolBadgesSection,
  ToolCodeSection,
  ToolDiffSection,
  ToolFileGroupsSection,
  ToolFileListSection,
  ToolFileNamespace,
  ToolFileSection,
  ToolIdentifierSection,
  ToolOutputSuppression,
  ToolRowModel,
  ToolSection,
  ToolSectionBase,
  ToolSectionFile,
  ToolStatusSection,
  ToolTextSection,
} from '@shared/transcript/toolRowModel';
export { toolDisplayKind, type ToolDisplayKind } from '@shared/tools/toolKind';
export {
  buildMcpToolName,
  isMcpToolName,
  normalizeToolName,
} from '@shared/tools/toolDisplayName';
// The limits a running tool's countdown shows, the same ones the tool
// enforces.
export {
  BASH_TOOL_DEFAULT_TIMEOUT_MS,
  EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
  executionsWaitTimeoutSeconds,
} from '@shared/toolUse';
// A script's stages and calls, and the children a dispatch card lists.
export {
  dispatchedChildren,
  scriptStages,
  type ScriptCallStatus,
  type ScriptCallView,
  type ScriptPhaseView,
  type ScriptStageView,
} from '@shared/transcript/scriptStage';
// A delivered follow-up as a renderer shows it: its tag, its summary, and
// a script delivery's tally; and the envelope tags a producer mints.
export {
  decodeXmlEntities,
  deliveryTagOf,
  formatScriptDeliverySummary,
  summarizeEmbeddedSubagentFollowups,
  summarizeSubagentFollowup,
} from '@shared/subagentFollowup';
export {
  DELIVERY_TAG,
  DELIVERY_TAGS,
  type DeliveryTagEntry,
  type DeliveryTagName,
} from '@shared/deliveryTags';
// Run lists and task groups: their order, a group's status, and a
// compaction's status.
export {
  compareByNewestCreationTime,
  compareBySeqNo,
} from '@shared/runs/runOrdering';
export { taskGroupDisplayStatus } from '@shared/runs/taskGroupProjection';
export type {
  CompactionActivityBlock,
  CompactionActivityStatus,
} from '@shared/runs/compactionActivityProjection';
// How the rows word what they count: a compact duration, a token count, a
// USD cost, and a count with its noun (or the noun alone). A host's own
// status line uses the same wording.
export {
  formatCompactDuration,
  formatCompactTokenCount,
  formatCostUsd,
  formatResultCount,
  pluralize,
} from '@utils/text/stringUtils';
