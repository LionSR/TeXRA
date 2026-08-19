/**
 * The transcript row model both hosts render.
 *
 * One row kind per thing a run says, carrying the typed payload and the
 * complete text. Rows never cross the wire — the frontend already receives
 * whole `StreamLogEntry` values and imports `@shared/*` — so this is a plain
 * type, not a schema: nothing parses it, and a schema would own no boundary.
 *
 * Three rules the shape encodes:
 *  - Text is untruncated. Elision is measurement ({@link TranscriptText}),
 *    applied by the painter at its own width.
 *  - Redaction already happened at record time in `TexraTranscriptRecorder`.
 *    Nothing here redacts.
 *  - Model ids arrive pre-projected. `projectWorkflowCallEntry`
 *    (`@model/projectWorkflowCallEntry`) turns a `WorkflowCallProgress.model`
 *    into its runtime label before the entry reaches this layer, so the row
 *    never reaches into the model registry (which is not browser-safe).
 */
import {
  TOOL_USE_STATUS,
  isTerminalWorkflowCallProgress,
  type ContextManagementData,
  type ContextStateData,
  type DiffResultDisplay,
  type ErrorLogData,
  type ExtendedTokenUsageStats,
  type FileListEntry,
  type LoadedMediaMetadata,
  type LogLevel,
  type MediaAttachmentKind,
  type MessageType,
  type NormalizedToolUse,
  type WorkflowCallProgress,
  type WorkflowScriptDeliverySummary,
} from '@shared/schemas';
import type { DeliveryTagName } from '@shared/deliveryTags';
import {
  COMPACTION_ACTIVITY_LABEL,
  type CompactionActivityBlock,
} from '@shared/streams/compactionActivityProjection';
import { assertNever } from '@utils/core';

import type { ToolRowModel } from './toolRowModel';
import type { TranscriptText } from './transcriptText';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Fields every row carries, projected from the source entry's envelope.
 * Optional keys are spread-omitted rather than set to `undefined`, so a row
 * built from the same entry twice is structurally identical.
 */
export interface TranscriptRowBase {
  /** Same id as the source `StreamLogEntry.id` — stable across deltas. */
  readonly id: string;
  /** Wire append order of the source entry. */
  readonly seqNo?: number;
  /** Order in which the source row became printable, when it has settled. */
  readonly settlementSeqNo?: number;
  readonly timestamp: number;
  readonly level: LogLevel;
  /** True when the row belongs to the verbose tier of its host's chrome. */
  readonly verbose?: boolean;
  readonly groupId?: string;
  /** Source vocabulary. Absent on the two rows with no message type of their
   *  own: `phase` (a group row) and `compactionActivity` (a projection). */
  readonly messageType?: MessageType;
  /** Recorder-owned full artifact for a text this row abbreviates. */
  readonly spillPath?: string;
  /** Set by a host's on-demand full-output reader when the {@link spillPath}
   *  artifact could not be loaded, so the painter shows the failure notice
   *  without the "full output" affordance. */
  readonly spillFailed?: boolean;
  /** Present when a host synthesized this row rather than projecting it from a
   *  `StreamLogEntry` — a local notice the run itself never recorded. Such a
   *  row is immutable from birth, carries the host's own id, and anchors into
   *  the merged order through the {@link seqNo}/{@link settlementSeqNo} the
   *  host captured when it appended it. */
  readonly origin?: 'local';
}

// ---------------------------------------------------------------------------
// Row variants
// ---------------------------------------------------------------------------

/** Model text, thinking, and scratchpad share one shape: streaming markdown. */
export interface StreamingTextRow extends TranscriptRowBase {
  readonly kind: 'assistant' | 'thinking' | 'scratchpad';
  readonly text: TranscriptText;
  /** True while the producer is still appending to `text`. */
  readonly streaming: boolean;
  /** True while the text hides an embedded subagent block that has opened but
   *  not closed. Blocks settlement: the visible text is still going to move. */
  readonly pendingEmbeddedFollowup?: boolean;
}

export interface UserRow extends TranscriptRowBase {
  readonly kind: 'user';
  /** The message exactly as delivered, including any delivery envelope. */
  readonly text: TranscriptText;
  /** Collapsed presentation of a subagent/workflow delivery. Derived, never a
   *  truncation of `text`: hosts choose which of the two to paint. */
  readonly summary: TranscriptText;
  readonly deliveryTag?: DeliveryTagName;
  readonly workflowSummary?: WorkflowScriptDeliverySummary;
  /** Media sent to the model with this message but never stored on the row. */
  readonly attachments?: readonly MediaAttachmentKind[];
}

/**
 * One `key: value` line of an error's detail block, pre-stringified so both
 * hosts show the same rendering of the same field.
 */
export interface ErrorRowDetail {
  readonly key: keyof ErrorLogData;
  readonly value: string;
}

export interface ErrorRow extends TranscriptRowBase {
  readonly kind: 'error';
  /** The failure headline. */
  readonly summary: TranscriptText;
  /** The full typed payload, untouched — including the fields `details`
   *  deliberately omits. */
  readonly data?: ErrorLogData;
  /** Canonical detail field set, in display order. */
  readonly details: readonly ErrorRowDetail[];
  /** The detail block as one text, for copy affordances and full-output
   *  readers. */
  readonly detailText: TranscriptText;
}

export interface ToolRow extends TranscriptRowBase {
  readonly kind: 'tool';
  readonly toolUse: NormalizedToolUse;
  readonly model: ToolRowModel;
}

interface WebSearchResultRef {
  readonly url?: string;
  readonly title?: string;
  readonly domain?: string;
}

export interface WebSearchRow extends TranscriptRowBase {
  readonly kind: 'webSearch';
  /** `Anthropic Search: "quantum error correction" (searching...)` */
  readonly label: string;
  readonly query?: string;
  readonly results: readonly WebSearchResultRef[];
  readonly provider?: string;
  readonly status?: string;
  readonly failed: boolean;
  readonly inProgress: boolean;
}

export interface WebFetchRow extends TranscriptRowBase {
  readonly kind: 'webFetch';
  /** `Web Fetch: arxiv.org (failed)` */
  readonly label: string;
  readonly url?: string;
  readonly title?: string;
  readonly status?: string;
  readonly errorCode?: string;
  /** Human-readable form of `errorCode`. */
  readonly errorLabel?: string;
  readonly content?: TranscriptText;
  readonly failed: boolean;
}

/** A file that came through the media pipeline as visual/audio model input. */
export interface LoadedMediaRef {
  readonly path: string;
  readonly media: LoadedMediaMetadata;
}

export interface FileListRow extends TranscriptRowBase {
  readonly kind: 'fileList';
  /** Which category of attachment this load reported (`input`, `media`, …). */
  readonly category: string;
  /** Every entry the loader reported, loaded and failed alike. */
  readonly files: readonly FileListEntry[];
  readonly counts: {
    readonly loaded: number;
    readonly failed: number;
    readonly total: number;
  };
  /** `Files (3/4 loaded, 1 not found)` — the one statement of partial load. */
  readonly summary: string;
  /** The subset a host can preview inline. Kept beside `files`, not instead
   *  of it: a failed or non-media attachment must stay visible. */
  readonly media: readonly LoadedMediaRef[];
}

export interface MissingOutputsRow extends TranscriptRowBase {
  readonly kind: 'missingOutputs';
  readonly missing: readonly string[];
  readonly xmlFile: string | null;
  /** `Missing outputs (2)` */
  readonly summary: string;
}

export interface LatexdiffRow extends TranscriptRowBase {
  readonly kind: 'latexdiff';
  readonly entries: readonly DiffResultDisplay[];
  readonly runId?: string;
}

/** One labeled number from a statistics or context-management row. */
export interface StatItem {
  /** Stable key hosts use to pick an icon; never shown as-is. */
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface StatisticsRow extends TranscriptRowBase {
  readonly kind: 'statistics';
  /** Partial by contract: a run reports only the counters its provider
   *  returned. */
  readonly stats: Partial<ExtendedTokenUsageStats>;
  /** `Statistics` — the panel heading, owned here so both hosts say the same
   *  word. Mirrors {@link ContextManagementRow.label}. */
  readonly label: string;
  readonly items: readonly StatItem[];
}

export interface ContextManagementRow extends TranscriptRowBase {
  readonly kind: 'contextManagement';
  readonly data: ContextManagementData;
  /** `Compacted`, `Cleared tool uses`, … */
  readonly label: string;
  readonly items: readonly StatItem[];
  readonly summary?: TranscriptText;
}

/**
 * Context utilization as the model handler actually measured it. Neither host
 * paints this inline: the webview folds it into the usage panel and the CLI
 * into its status bar. It is a row so the fact travels the same path as every
 * other one, with one owner instead of a second derivation per host.
 */
interface ContextStateRow extends TranscriptRowBase {
  readonly kind: 'contextState';
  readonly data: ContextStateData;
}

export interface ProgressStatusRow extends TranscriptRowBase {
  readonly kind: 'progressStatus';
  readonly summary: TranscriptText;
  readonly detail?: TranscriptText;
}

export interface WorkflowTaskRow extends TranscriptRowBase {
  readonly kind: 'workflowTask';
  readonly call: WorkflowCallProgress;
  /** `Finished: Draft · claude-opus-4 · 1m 12s · $0.31` */
  readonly line: string;
  readonly statusLabel: string;
  readonly metadataParts: readonly string[];
  readonly detail?: { readonly kind: 'error' | 'note'; readonly text: string };
}

export interface CompactionActivityRow extends TranscriptRowBase {
  readonly kind: 'compactionActivity';
  readonly block: CompactionActivityBlock;
  readonly label: string;
}

export interface PhaseRow extends TranscriptRowBase {
  readonly kind: 'phase';
  /** `Reduce (2/3)` */
  readonly heading: string;
  readonly phaseLabel: string;
  readonly phaseIndex?: number;
  readonly phaseTotal?: number;
  readonly attemptId?: string;
}

/** A plain log line: a `default` row, a row with no message type, or a
 *  non-phase group heading on a stream that keeps its lifecycle inline. */
export interface LogRow extends TranscriptRowBase {
  readonly kind: 'log';
  readonly text: TranscriptText;
}

export type TranscriptRow =
  | StreamingTextRow
  | UserRow
  | ErrorRow
  | ToolRow
  | WebSearchRow
  | WebFetchRow
  | FileListRow
  | MissingOutputsRow
  | LatexdiffRow
  | StatisticsRow
  | ContextManagementRow
  | ContextStateRow
  | ProgressStatusRow
  | WorkflowTaskRow
  | CompactionActivityRow
  | PhaseRow
  | LogRow;

export type TranscriptRowKind = TranscriptRow['kind'];

export type TranscriptRowOf<K extends TranscriptRowKind> = Extract<
  TranscriptRow,
  { kind: K }
>;

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Whether a row's content can no longer change, so it is safe to print once
 * into append-only scrollback.
 *
 * `hasLaterRow` is the one positional fact the projector cannot answer: a
 * streaming text block is frozen when the producer has moved on to something
 * else. Hosts with no append-only surface may pass `true`.
 */
export function isSettledRow(
  row: TranscriptRow,
  hasLaterRow: boolean,
): boolean {
  // A host-synthesized row has no producer still writing to it.
  if (row.origin === 'local') return true;
  switch (row.kind) {
    case 'assistant':
      return !row.pendingEmbeddedFollowup && hasLaterRow;
    case 'thinking':
    case 'scratchpad':
      return !row.streaming && hasLaterRow;
    case 'tool':
      return (
        row.toolUse.status === TOOL_USE_STATUS.COMPLETED ||
        row.toolUse.status === TOOL_USE_STATUS.FAILED
      );
    case 'workflowTask':
      return isTerminalWorkflowCallProgress(row.call);
    case 'compactionActivity':
      return row.block.finalized;
    case 'webSearch':
      return !row.inProgress;
    case 'webFetch':
      return row.status !== 'in_progress';
    case 'user':
    case 'error':
    case 'fileList':
    case 'missingOutputs':
    case 'latexdiff':
    case 'statistics':
    case 'contextManagement':
    case 'contextState':
    case 'progressStatus':
    case 'phase':
    case 'log':
      return true;
    default:
      return assertNever(row, 'Unhandled transcript row kind');
  }
}

/**
 * Rows a final stream status cannot promote on its own. Bridge cleanup can
 * still replace a planned/running compaction or workflow call after a
 * cancellation, so those two settle only on their own typed terminal state.
 */
export function promotesOnlyOnTypedTerminalState(row: TranscriptRow): boolean {
  return row.kind === 'compactionActivity' || row.kind === 'workflowTask';
}

// ---------------------------------------------------------------------------
// Compaction activity
// ---------------------------------------------------------------------------

/**
 * The row for one projected compaction block. Both hosts previously wrote
 * this constructor by hand from the same projection; it lives here so the id,
 * ordering key and label are stated once.
 */
export function compactionActivityRow(
  block: CompactionActivityBlock,
): CompactionActivityRow {
  return {
    kind: 'compactionActivity',
    id: `compaction:${block.operationId}`,
    seqNo: block.startPosition,
    timestamp: block.startedAt,
    level: 'info',
    block,
    label: COMPACTION_ACTIVITY_LABEL[block.status],
  };
}
