// Flatten a stream's conversation entries into full-fidelity plain-text lines
// for the ctrl+t transcript viewer. Unlike the finalized scrollback and the
// live region — which slice tool output to a head+tail preview — this renders
// every line so the viewer is the place to read the complete output.

import { wrapAnsiToWidth } from '../render/ansiWrap';
import { completedProcessDisplayLines } from './completedProcessTranscript';
import { toolUseDisplayLines } from '../panes/toolRenderers';
import type { ConversationEntry, StreamSlice } from './cliState';

function wrap(text: string, cols: number, prefix = ''): string[] {
  const width = Math.max(1, cols - prefix.length);
  return wrapAnsiToWidth(text, width)
    .split('\n')
    .map(
      (line, index) =>
        `${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`,
    );
}

export function transcriptEntryLines(
  entry: ConversationEntry,
  cols: number,
): readonly string[] {
  switch (entry.role) {
    case 'tool':
      return entry.toolUse
        ? toolUseDisplayLines(entry.toolUse, { elide: false })
        : [];
    case 'process':
      return entry.process ? completedProcessDisplayLines(entry.process) : [];
    case 'user':
      return wrap(entry.text, cols, '› ');
    case 'error':
      return wrap(entry.text, cols, '! ');
    default:
      return wrap(entry.text, cols);
  }
}

function isCompactToolEntry(
  entry: ConversationEntry,
  lines: readonly string[],
): boolean {
  return entry.role === 'tool' && lines.length <= 1;
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
  return !(
    isCompactToolEntry(previousEntry, previousLines) &&
    isCompactToolEntry(nextEntry, nextLines)
  );
}

/** Render the active slice into a flat line array with blank separators between
 *  substantial entries. Adjacent one-line tool calls stay stacked so compact
 *  tool-heavy traces do not waste half the viewer on empty expansion space. */
export function transcriptToLines(
  slice: StreamSlice | undefined,
  cols: number,
): readonly string[] {
  if (!slice) return [];
  const out: string[] = [];
  let previousEntry: ConversationEntry | undefined;
  let previousLines: readonly string[] = [];
  for (const entry of slice.entries) {
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
