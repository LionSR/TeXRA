// What a renderer paints a session's transcript from, browser-safe like
// `./schemas`: the rows a `TranscriptView` (`./schemas`) holds and the
// projections every host derives from them.

// The rows: one kind each, the headline a row is listed by, and the
// untruncated text a host elides to fit.
export { rowHeadline } from '@shared/transcript/transcriptRow';
export type {
  CompactionActivityRow,
  ContextManagementRow,
  ErrorRow,
  FileListRow,
  LogRow,
  ProgressStatusRow,
  StatItem,
  StreamingTextRow,
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
  ToolFileGroupsSection,
  ToolFileListSection,
  ToolFileSection,
  ToolSection,
  ToolSectionFile,
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
  SCRIPT_CALL_STATUS_LABEL,
  scriptStages,
  type ScriptCallStatus,
  type ScriptCallView,
  type ScriptPhaseView,
  type ScriptStageView,
} from '@shared/transcript/scriptStage';
// A delivered follow-up as a renderer shows it: its tag, its summary, and
// a script delivery's tally.
export {
  decodeXmlEntities,
  deliveryTagOf,
  formatScriptDeliverySummary,
  summarizeEmbeddedSubagentFollowups,
  summarizeSubagentFollowup,
} from '@shared/subagentFollowup';
export type { DeliveryTagName } from '@shared/deliveryTags';
// Run lists and task groups: their order, a group's status, and a
// compaction's status.
export {
  compareByNewestCreationTime,
  compareBySeqNo,
} from '@shared/runs/runOrdering';
export { taskGroupDisplayStatus } from '@shared/runs/taskGroupProjection';
export type { CompactionActivityStatus } from '@shared/runs/compactionActivityProjection';
// How the rows word what they count: a compact duration, a token count, a
// USD cost, and a count with its noun. A host's own status line uses the
// same wording.
export {
  formatCompactDuration,
  formatCompactTokenCount,
  formatCostUsd,
  formatResultCount,
} from '@utils/text/stringUtils';
