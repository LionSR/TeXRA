/**
 * Browser-safe transcript row projections and cross-process view
 * synchronization for UI renderers (CLI TUI, VS Code webviews, desktop
 * renderer, and static trace viewer).
 *
 * > **Guide:** Read [Views, Transcripts & Renderers](/api/views-and-transcripts)
 * > for how `SessionView`, `RemoteSessionView`, and `TranscriptRow` fit
 * > together, with end-to-end rendering examples.
 *
 * ### Key exports by role
 *
 * - **Cross-process view synchronization**: [`RemoteSessionView`](#remotesessionview)
 *   and [`SessionInputs`](#sessioninputs) keep a renderer's `SessionView` in
 *   sync across an IPC or message transport using ordered event batches
 *   ([`CommitOrdinalSchema`](#commitordinalschema),
 *   [`EventInputSchema`](#eventinputschema)), the other inputs a transport
 *   serves ([`SessionViewInputSchema`](#sessionviewinputschema)), and
 *   transcript subscriptions
 *   ([`TranscriptSubscriptionSchema`](#transcriptsubscriptionschema)).
 * - **Transcript row union**: [`TranscriptRow`](#transcriptrow) (with shared
 *   fields on [`TranscriptRowBase`](#transcriptrowbase)) discriminates on
 *   `kind` across [`UserRow`](#userrow),
 *   [`StreamingTextRow`](#streamingtextrow), [`ToolRow`](#toolrow),
 *   [`CompactionActivityRow`](#compactionactivityrow),
 *   [`ContextManagementRow`](#contextmanagementrow),
 *   [`WebSearchRow`](#websearchrow), [`ErrorRow`](#errorrow),
 *   [`FileListRow`](#filelistrow), [`LogRow`](#logrow), and
 *   [`ProgressStatusRow`](#progressstatusrow).
 * - **Structured tool cards**: [`ToolRowModel`](#toolrowmodel) and
 *   [`ToolSection`](#toolsection) (`ToolStatusSection`, `ToolBadgesSection`,
 *   `ToolDiffSection`, `ToolCodeSection`, `ToolTextSection`, `ToolFileSection`,
 *   `ToolFileListSection`, `ToolFileGroupsSection`) structure tool inputs and
 *   outputs without custom per-tool UI parsing.
 * - **Text budgets & headlines**: [`rowHeadline`](#rowheadline),
 *   [`transcriptText`](#transcripttext), [`elideText`](#elidetext), and
 *   [`TextBudget`](#textbudget) format and truncate row text for terminal and
 *   compact UIs.
 */
// What a renderer paints a session's transcript from, browser-safe like
// `./schemas`: the view built from a transport, the rows a `TranscriptView`
// (`./schemas`) holds, and the projections every host derives from them.

// A session's view across a process boundary: built from the inputs the
// caller's transport serves.
export { RemoteSessionView } from '@controllers/session/sessionViewService';
export type { TranscriptInterest } from '@shared/session/sessionViewAccess';
export { SessionInputs } from '@shared/session/sessionInputs';
export {
  CommitOrdinalSchema,
  DisplayRowSchema,
  EventInputSchema,
  SessionViewInputSchema,
  TranscriptSubscriptionSchema,
  type CommitOrdinal,
  type SessionViewInput,
  type TranscriptSubscription,
} from '@shared/schemas';
// The runtime a view is built on: fork failures reported, and the redacting
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
  ErrorDetailKey,
  ErrorRow,
  ErrorRowDetail,
  FileListRow,
  LoadedMediaRef,
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
  mcpServerOfToolName,
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
  isScriptCall,
  scriptStages,
  type ScriptCallStatus,
  type ScriptCallView,
  type ScriptSectionView,
  type ScriptStageView,
} from '@shared/transcript/scriptStage';
// A transcript's stages with their rows, among its other rows.
export {
  transcriptTimeline,
  type TimelineEntry,
} from '@shared/transcript/transcriptTimeline';
// Delivery envelopes inside assistant text, collapsed to their summaries,
// and the entity decoding their bodies take.
export {
  decodeXmlEntities,
  summarizeEmbeddedSubagentFollowups,
} from '@shared/subagentFollowup';
// Run lists' order, and a compaction's status.
export { compareByNewestCreationTime } from '@shared/runs/runOrdering';
export type {
  CompactionActivityBlock,
  CompactionActivityStatus,
} from '@shared/runs/compactionActivityProjection';
