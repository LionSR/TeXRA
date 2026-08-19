/**
 * The shared transcript model: one projection from a stream-log entry to a
 * row, one tool-row fold, and the untruncated-text/elision contract both
 * hosts paint against. This barrel is the module's public surface — the CLI
 * TUI and the progress view import from here, not from the files below.
 *
 * The surface is only what a host actually names. Union members and internal
 * shapes stay unexported: a painter reaches them by narrowing `TranscriptRow`
 * or `ToolSection`, so re-exporting each one would be surface nobody imports.
 */
export { projectTranscriptRow } from './projectTranscriptRow';
export {
  compactionActivityRow,
  isSelfSettledRow,
  isSettledRow,
  promotesOnlyOnTypedTerminalState,
  type CompactionActivityRow,
  type ContextManagementRow,
  type ErrorRow,
  type FileListRow,
  type LatexdiffRow,
  type LogRow,
  type MissingOutputsRow,
  type PhaseRow,
  type ProgressStatusRow,
  type StatItem,
  type StatisticsRow,
  type StreamingTextRow,
  type ToolRow,
  type TranscriptRow,
  type TranscriptRowBase,
  type TranscriptRowKind,
  type TranscriptRowOf,
  type UserRow,
  type WebFetchRow,
  type WebSearchRow,
  type WorkflowTaskRow,
} from './transcriptRow';
export {
  toolRowModel,
  type ToolChecklistSection,
  type ToolFileGroupsSection,
  type ToolFileListSection,
  type ToolFileSection,
  type ToolSection,
  type ToolSectionFile,
} from './toolRowModel';
export {
  elideText,
  transcriptText,
  type TranscriptText,
} from './transcriptText';
