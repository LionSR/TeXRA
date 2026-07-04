// Flatten a stream's conversation entries into full-fidelity plain-text lines
// for the ctrl+t transcript viewer. Unlike the finalized scrollback and the
// live region — which slice tool output to a head+tail preview — this renders
// every line so the viewer is the place to read the complete output.

import { wrapAnsiToWidth } from '../render/ansiWrap';
import { completedProcessDisplayLines } from './completedProcessTranscript';
import { isRenderableTranscriptEntry } from '../panes/transcriptEntries';
import { toolUseDisplayLines } from '../panes/toolRenderers';
import { TOOL_OUTPUT_CORNER } from '../ui/glyphs';
import type { ConversationEntry, StreamSlice } from './cliState';

/** Gutter that opens a wrapped tool-output line (corner glyph + space). */
const CORNER_PREFIX = `${TOOL_OUTPUT_CORNER} `;

/** Soft-wrap `body` to `cols`, prefixing the first wrapped line with
 *  `firstPrefix` and every continuation line with `contPrefix` (spaces matching
 *  the first prefix by default, for a hanging indent). */
function wrapWithPrefix(
  body: string,
  cols: number,
  firstPrefix = '',
  contPrefix = ' '.repeat(firstPrefix.length),
): string[] {
  const width = Math.max(1, cols - firstPrefix.length);
  return wrapAnsiToWidth(body, width)
    .split('\n')
    .map((line, index) => `${index === 0 ? firstPrefix : contPrefix}${line}`);
}

function leadingWhitespacePrefix(line: string): string {
  return line.match(/^\s+/)?.[0] ?? '';
}

function wrapDisplayLine(line: string, cols: number): string[] {
  if (line.startsWith(CORNER_PREFIX)) {
    return wrapWithPrefix(
      line.slice(CORNER_PREFIX.length),
      cols,
      CORNER_PREFIX,
    );
  }
  // Repeat any leading indentation on every wrapped line so nested output keeps
  // its shape.
  const prefix = leadingWhitespacePrefix(line);
  return wrapWithPrefix(line.slice(prefix.length), cols, prefix, prefix);
}

function wrapLines(lines: readonly string[], cols: number): string[] {
  return lines.flatMap((line) => wrapDisplayLine(line, cols));
}

// Wrapped-line cache keyed by the immutable entry object. Entries are
// replaced (never mutated in place) when their content changes, so hits are
// always current. Each entry can be rendered at several widths in the same
// frame (terminal transcript, static row budget, task-detail panel), so keep
// the width dimension inside the entry cache instead of letting callers thrash
// a single slot.
const entryLinesCache = new WeakMap<
  ConversationEntry,
  Map<number, readonly string[]>
>();

export function transcriptEntryLines(
  entry: ConversationEntry,
  cols: number,
): readonly string[] {
  const cachedByCols = entryLinesCache.get(entry);
  const cached = cachedByCols?.get(cols);
  if (cached) return cached;
  const lines = computeTranscriptEntryLines(entry, cols);
  if (cachedByCols) {
    cachedByCols.set(cols, lines);
  } else {
    entryLinesCache.set(entry, new Map([[cols, lines]]));
  }
  return lines;
}

function computeTranscriptEntryLines(
  entry: ConversationEntry,
  cols: number,
): readonly string[] {
  switch (entry.role) {
    case 'tool':
      return wrapLines(
        toolUseDisplayLines(entry.toolUse, { elide: false }),
        cols,
      );
    case 'process':
      return wrapLines(completedProcessDisplayLines(entry.process), cols);
    case 'user':
      return wrapWithPrefix(entry.text, cols, '› ');
    case 'error':
      return wrapWithPrefix(entry.text, cols, '! ');
    default:
      return wrapWithPrefix(entry.text, cols);
  }
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
): readonly string[] {
  if (!slice) return [];
  const out: string[] = [];
  let previousEntry: ConversationEntry | undefined;
  let previousLines: readonly string[] = [];
  for (const entry of slice.entries) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    const lines = transcriptEntryLines(entry, cols);
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
