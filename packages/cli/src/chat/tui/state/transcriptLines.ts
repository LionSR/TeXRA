// Flatten a stream's conversation entries into full-fidelity plain-text lines
// for print-once terminal output. Unlike the finalized scrollback and the live
// region, this renders every tool-output line.

import stripAnsi from 'strip-ansi';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import { isRenderableTranscriptEntry } from '../panes/transcriptEntries';
import { fullTranscriptEntryLayout } from '../panes/transcriptEntryLayout';
import type { ConversationEntry, StreamSlice } from './cliState';

export interface TranscriptPrintRequest {
  readonly afterEntryId?: string;
  readonly id: string;
  readonly ownerKey: string;
  readonly slice: StreamSlice | undefined;
  readonly title?: string;
}

/** Capture the stream state at the moment the user asks to print it. */
export function createTranscriptPrintRequest({
  afterEntryId,
  id,
  ownerKey,
  slice,
  title,
}: TranscriptPrintRequest): TranscriptPrintRequest {
  return {
    afterEntryId,
    id,
    ownerKey,
    title,
    slice: slice ? { ...slice, entries: [...slice.entries] } : undefined,
  };
}

// Wrapped-line cache keyed by the immutable entry object. Entries are
// replaced (never mutated in place) when their content changes, so hits are
// always current. Each entry can be rendered at several widths in the same
// frame (terminal transcript, static row budget, task-detail panel), so keep
// the width dimension inside the entry cache instead of letting callers thrash
// a single slot.
const EMPTY_EXECUTION_LABELS: ExecutionLabels = new Map();
const entryLinesCache = new WeakMap<
  ConversationEntry,
  WeakMap<ExecutionLabels, Map<number, readonly string[]>>
>();

function transcriptEntryLines(
  entry: ConversationEntry,
  cols: number,
  executionLabels: ExecutionLabels,
): readonly string[] {
  const cachedByLabels = entryLinesCache.get(entry);
  const cachedByCols = cachedByLabels?.get(executionLabels);
  const cached = cachedByCols?.get(cols);
  if (cached) return cached;
  const lines = computeTranscriptEntryLines(entry, cols, executionLabels);
  if (cachedByCols) {
    cachedByCols.set(cols, lines);
  } else if (cachedByLabels) {
    cachedByLabels.set(executionLabels, new Map([[cols, lines]]));
  } else {
    entryLinesCache.set(
      entry,
      new WeakMap([[executionLabels, new Map([[cols, lines]])]]),
    );
  }
  return lines;
}

function computeTranscriptEntryLines(
  entry: ConversationEntry,
  cols: number,
  executionLabels: ExecutionLabels,
): readonly string[] {
  return fullTranscriptEntryLayout(entry, cols, executionLabels).lines;
}

function isCompactToolEntry(
  entry: ConversationEntry,
  lines: readonly string[],
): boolean {
  return entry.role === 'tool' && lines.length <= 1;
}

function isPromptToToolTurn(
  previousEntry: ConversationEntry,
  nextEntry: ConversationEntry,
): boolean {
  return previousEntry.role === 'user' && nextEntry.role === 'tool';
}

function shouldSeparateEntries({
  previousEntry,
  previousLines,
  nextEntry,
  nextLines,
}: {
  readonly previousEntry: ConversationEntry | undefined;
  readonly previousLines: readonly string[];
  readonly nextEntry: ConversationEntry;
  readonly nextLines: readonly string[];
}): boolean {
  if (!previousEntry) return false;
  if (isPromptToToolTurn(previousEntry, nextEntry)) return false;
  return !(
    isCompactToolEntry(previousEntry, previousLines) &&
    isCompactToolEntry(nextEntry, nextLines)
  );
}

/** Render the active slice into a flat line array with blank separators between
 *  substantial entries. Tool execution rows stay attached to the prompt or
 *  adjacent compact tools so command-heavy traces do not waste vertical space. */
export function transcriptToLines(
  slice: StreamSlice | undefined,
  cols: number,
  executionLabels: ExecutionLabels = EMPTY_EXECUTION_LABELS,
): readonly string[] {
  if (!slice) return [];
  const out: string[] = [];
  let previousEntry: ConversationEntry | undefined;
  let previousLines: readonly string[] = [];
  for (const entry of slice.entries) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    const lines = transcriptEntryLines(entry, cols, executionLabels);
    if (lines.length === 0) continue;
    if (
      out.length > 0 &&
      shouldSeparateEntries({
        previousEntry,
        previousLines,
        nextEntry: entry,
        nextLines: lines,
      })
    ) {
      out.push('');
    }
    out.push(...lines);
    previousEntry = entry;
    previousLines = lines;
  }
  return out;
}

const UNSAFE_TERMINAL_CONTROLS =
  // eslint-disable-next-line no-control-regex -- terminal output must exclude C0/C1 controls
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function safeTerminalText(text: string): string {
  return stripAnsi(text)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\t', '  ')
    .replaceAll(UNSAFE_TERMINAL_CONTROLS, '');
}

/** Format one immutable request for the terminal's static scrollback. */
export function formatTranscriptForScrollback({
  cols,
  executionLabels = EMPTY_EXECUTION_LABELS,
  request,
}: {
  readonly cols: number;
  readonly executionLabels?: ExecutionLabels;
  readonly request: TranscriptPrintRequest;
}): string {
  const heading = safeTerminalText(request.title ?? '')
    .replaceAll('\n', ' ')
    .trim();
  const body = safeTerminalText(
    transcriptToLines(request.slice, cols, executionLabels).join('\n'),
  );
  const label = heading ? `Full output: ${heading}` : 'Full output';
  return `\n[${label}]\n${body.trimEnd() || '(no output yet)'}\n`;
}
