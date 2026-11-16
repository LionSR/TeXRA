/**
 * The transcript row model both hosts render.
 *
 * One row kind per thing a run says, carrying the typed payload and the
 * complete text. Rows are a fold output built from already-decoded values
 * by the transcript fold, so this is a plain type, not a schema:
 * nothing parses it, and a schema would own no boundary.
 *
 * Text is untruncated. Elision is measurement ({@link TranscriptText}),
 * applied by the painter at its own width.
 */
import { absurd } from 'effect';
import {
  TOOL_CALL_STATUS,
  type ContextManagementData,
  type ModelFailure,
  type FileListEntry,
  type MediaAttachmentKind,
  type LogLevel,
  type MessageType,
  type NormalizedToolUse,
  type ResponseCut,
  type ToolUseLog,
  type ScriptDeliverySummary,
  type StoredMedia,
} from '@shared/schemas';
import {
  COMPACTION_ACTIVITY_LABEL,
  type CompactionActivityBlock,
} from '@shared/runs/compactionActivityProjection';
import type { ReadonlyDeep } from '@shared/session/readonlyDeep';
import { formatCompactTokenCount, joinFacts } from '@utils/text/stringUtils';

import type { ToolRowModel } from './toolRowModel';
import type { TranscriptText } from './transcriptText';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Fields every row carries, stamped by the transcript fold from the event
 * that wrote it. Optional keys are spread-omitted rather than set to
 * `undefined`, so a row built from the same facts twice is structurally
 * identical.
 */
export interface TranscriptRowBase {
  /** The writing event's id (a card's, a stream's, a stage's) or its durable
   *  coordinates; stable across deltas. */
  readonly id: string;
  /** First-appearance order of the row within its run's transcript: the
   *  fold's slot counter. A host-local row carries the position it was
   *  written after (0: before every row), which places it in the merge. */
  readonly seqNo: number;
  /** Order in which the source row became printable, when it has finished. */
  readonly finalSeqNo?: number;
  readonly timestamp: number;
  readonly level: LogLevel;
  /** True when the row belongs to the verbose tier of its host's chrome. */
  readonly verbose?: boolean;
  /** The stage the row belongs to (`Stage.id`), from its event's
   *  `stageId`. */
  readonly stageId?: string;
  /** Source vocabulary. Absent on the one row with no message type of its
   *  own, `compactionActivity` (a projection). */
  readonly messageType?: MessageType;
  /** Present when a host synthesized this row rather than the fold building
   *  it from an event: a local notice the run itself never recorded. Such a
   *  row is immutable from birth, carries the host's own id, and takes its
   *  place in the order where the host merges it into the run's rows. */
  readonly origin?: 'local';
}

// ---------------------------------------------------------------------------
// Row variants
// ---------------------------------------------------------------------------

/** Model text and thinking share one shape: streaming markdown. */
export interface StreamingTextRow extends TranscriptRowBase {
  readonly kind: 'assistant' | 'thinking';
  readonly text: TranscriptText;
  /** True while the producer is still appending to `text`. */
  readonly streaming: boolean;
  /** True while the text hides an embedded subagent block that has opened but
   *  not closed. Blocks result: the visible text is still going to move. */
  readonly pendingEmbeddedFollowup?: boolean;
  /** The limit that ended an assistant's answer early, from its
   *  `response.finalized` row; each reader words it. */
  readonly cut?: ResponseCut;
}

export interface UserRow extends TranscriptRowBase {
  readonly kind: 'user';
  /** The message as its follow-up shows it (`followUpDisplay`): a delivery
   *  or notice is its summary, not its envelope. */
  readonly text: TranscriptText;
  /** A script delivery's facts, typed. */
  readonly scriptSummary?: ReadonlyDeep<ScriptDeliverySummary>;
  /** Media that was sent to the model beside the text, by kind (no bytes);
   *  empty when none was. */
  readonly attachments: readonly MediaAttachmentKind[];
  /** What a follow-up attached, by address, which "Fork from here" carries;
   *  empty when it attached nothing. */
  readonly media: readonly StoredMedia[];
  /** The finished point "Fork from here" cuts at: the `seq` of the park the
   *  run stood at before it took this message. Absent on the first message,
   *  which no park precedes. */
  readonly forkAt?: number;
}

/** The fields an error's detail block shows, in display order. */
export const ERROR_DETAIL_KEYS = Object.freeze([
  'message',
  'operation',
  'model',
  'provider',
  'statusCode',
  'statusText',
  'requestId',
  'rawMessage',
] as const);
/** One of {@link ERROR_DETAIL_KEYS}. */
export type ErrorDetailKey = (typeof ERROR_DETAIL_KEYS)[number];

/**
 * One `key: value` line of an error's detail block, pre-stringified so both
 * hosts show the same rendering of the same field.
 */
export interface ErrorRowDetail {
  readonly key: ErrorDetailKey;
  readonly value: string;
}

export interface ErrorRow extends TranscriptRowBase {
  readonly kind: 'error';
  /** The failure headline. */
  readonly summary: TranscriptText;
  /** Canonical detail field set, in display order: a host shows each as a
   *  `key: value` line. */
  readonly details: readonly ErrorRowDetail[];
  /** The model call's failure the row records, as its verdict: an app
   *  with words of its own for it shows them where the row shows the
   *  verdict's plain words (the summary, or the `message` detail). */
  readonly failure?: ModelFailure;
}

export interface ToolRow extends TranscriptRowBase {
  readonly kind: 'tool';
  readonly toolUse: NormalizedToolUse;
  readonly model: ToolRowModel;
  /** The decoded durable payload the row was built from, without live
   *  output: what a conversation export formats. */
  readonly log: ToolUseLog;
  /** A script's call's section, as its card's `tool.start` names it. */
  readonly section?: string;
  /** The call's attempt, from the second on (its card's `tool.start`). */
  readonly attempt?: number;
  /** The run waited or ended while the call was open: the call never
   *  finished, so nothing records how it ended, and the row reads failed.
   *  A result that lands once the run runs again replaces it. The row
   *  holds no text for it; every reader says {@link CUT_BY_RUN_END_NOTE}. */
  readonly cutByRunEnd?: true;
}

/** What a call the run's end cut short ({@link ToolRow.cutByRunEnd}) reads
 *  as, to the model reading the run, an export and the tool's card alike. */
export const CUT_BY_RUN_END_NOTE = 'The task ended before this tool completed.';

/** A web search the model ran; its headline is the query ({@link rowHeadline}). */
export interface WebSearchRow extends TranscriptRowBase {
  readonly kind: 'webSearch';
  readonly query?: string;
}

export interface FileListRow extends TranscriptRowBase {
  readonly kind: 'fileList';
  /** Every entry the loader reported, loaded and failed alike. An entry's
   *  `media` (the kind and size a host shows beside its name) is kept only
   *  on a file that loaded through the media pipeline. */
  readonly files: readonly FileListEntry[];
  /** `Files (3/4 loaded, 1 not found)` — the one statement of partial load. */
  readonly summary: string;
}

/** One labeled number from a context-management row. */
export interface StatItem {
  /** Stable key hosts use to pick an icon; never shown as-is. */
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface ContextManagementRow extends TranscriptRowBase {
  readonly kind: 'contextManagement';
  readonly data: ContextManagementData;
  /** `Compacted`, `Cleared tool uses`, … */
  readonly label: string;
  readonly items: readonly StatItem[];
}

/** A status note: its message, and no untyped payload beside it. */
export interface ProgressStatusRow extends TranscriptRowBase {
  readonly kind: 'progressStatus';
  readonly summary: TranscriptText;
}

export interface CompactionActivityRow extends TranscriptRowBase {
  readonly kind: 'compactionActivity';
  readonly block: CompactionActivityBlock;
  readonly label: string;
}

/** A plain log line: a `default` row, or a row with no message type. */
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
  | FileListRow
  | ContextManagementRow
  | ProgressStatusRow
  | CompactionActivityRow
  | LogRow;

export type TranscriptRowKind = TranscriptRow['kind'];

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Kinds whose content is complete the moment the row appears. A tool call or a
 * script stage is deliberately absent: it does reach a typed terminal state,
 * but only in a position the producer chose, so it finishes through
 * {@link isFinalRow} rather than on its own.
 */
const IMMEDIATELY_FINAL_ROW_KINDS = new Set<TranscriptRowKind>([
  'user',
  'error',
  'fileList',
  'contextManagement',
  'progressStatus',
]);

/**
 * Whether a row's content is fixed the moment it appears, independent of
 * anything around it — the recorder assigned it a durable result order,
 * the host synthesized it so no producer is still writing to it, a compaction
 * block reached a terminal state, or the kind is complete on arrival.
 *
 * This is the position-independent half of {@link isFinalRow}, which a host
 * with an append-only surface asks about a row it holds no position for.
 */
function isSelfFinalRow(row: TranscriptRow): boolean {
  if (row.kind === 'compactionActivity') return row.block.finalized;
  return (
    row.finalSeqNo !== undefined ||
    row.origin === 'local' ||
    IMMEDIATELY_FINAL_ROW_KINDS.has(row.kind)
  );
}

/**
 * Whether a row's content can no longer change, so it is safe to print once
 * into append-only scrollback.
 *
 * Opens with {@link isSelfFinalRow}: a row that is finished independent of
 * position is finished full stop, without consulting `hasLaterRow` or the
 * kind-specific terminal-state tests below. That containment
 * (`isFinalRow` ⊇ `isSelfFinalRow`) is load-bearing — the promotion loop
 * relies on it to treat both halves as one predicate.
 *
 * `hasLaterRow` is the one positional fact the projector cannot answer: a
 * streaming text block is frozen when the producer has moved on to something
 * else. Hosts with no append-only surface may pass `true`.
 */
export function isFinalRow(row: TranscriptRow, hasLaterRow: boolean): boolean {
  if (isSelfFinalRow(row)) return true;
  switch (row.kind) {
    case 'assistant':
      return !row.pendingEmbeddedFollowup && hasLaterRow;
    case 'thinking':
      return !row.streaming && hasLaterRow;
    case 'tool':
      return (
        row.toolUse.status === TOOL_CALL_STATUS.COMPLETED ||
        row.toolUse.status === TOOL_CALL_STATUS.FAILED
      );
    case 'compactionActivity':
      return row.block.finalized;
    case 'webSearch':
    case 'user':
    case 'error':
    case 'fileList':
    case 'contextManagement':
    case 'progressStatus':
    case 'log':
      return true;
    default:
      return absurd(row);
  }
}

/** The headline a row leads with: its own text, untrimmed and unsanitized;
 *  a host sanitizes for its surface at paint. */
export function rowHeadline(row: ReadonlyDeep<TranscriptRow>): string {
  switch (row.kind) {
    case 'assistant':
    case 'log':
    case 'user':
      return row.text.full;
    case 'error':
    case 'progressStatus':
      return row.summary.full;
    case 'thinking':
      return 'Thinking';
    case 'webSearch':
      return `Web Search${row.query ? `: "${row.query}"` : ''}`;
    case 'contextManagement':
    case 'compactionActivity':
      return row.label;
    case 'fileList':
      return row.summary;
    case 'tool':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Compaction activity
// ---------------------------------------------------------------------------

/**
 * The row for one projected compaction block: its id, ordering key and label,
 * stated once for every host.
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
    // `Context compacted · freed 41k tokens (78% → 22%)`.
    label: joinFacts([
      COMPACTION_ACTIVITY_LABEL[block.status],
      block.freed &&
        block.freed.tokens > 0 &&
        `freed ${formatCompactTokenCount(block.freed.tokens)} tokens (${block.freed.utilizationBefore.toFixed(0)}% → ${block.freed.utilizationAfter.toFixed(0)}%)`,
    ]),
  };
}
