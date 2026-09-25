// Terminal paint of a shared transcript row's body.
//
// `@ui/transcript` carries every text untruncated plus the measurements
// needed to elide it; this module is where the terminal spends its own budget
// — a head/tail line slice with a `N lines hidden` marker, and a terminal-safe pass
// over text a producer wrote. Nothing here truncates the model.

import { safeTerminalText } from '@cli/runtime/terminalText';
import { hiddenRowsText } from '@cli/tui/overflowText';
import { CROSS, TICK, TOOL_OUTPUT_CORNER } from '@cli/tui/ui/glyphs';
import {
  elideText,
  transcriptText,
  type StatItem,
  type TranscriptRow,
  type TranscriptText,
} from '@ui/transcript';
import { formatBytes } from '@utils/text/stringUtils';

// A body block can be arbitrarily large (a 50 KB tool dump, a long error
// payload). Finalized scrollback and the live region show a head+tail slice
// with a `… +N lines` marker; the untruncated text stays on the row and is
// printed in full by the ctrl+t reader. Tune head/tail here.
const ROW_BODY_HEAD_LINES = 6;
const ROW_BODY_TAIL_LINES = 3;

const UNBOUNDED_BUDGET = {
  headLines: Number.POSITIVE_INFINITY,
  tailLines: 0,
} as const;

// Sanitized once per text, and before the line split: the pass turns `\r`
// into a line break, so the elision budget must count the lines that paint.
const SAFE_TEXT_CACHE = new WeakMap<TranscriptText, TranscriptText>();

function safeTranscriptText(text: TranscriptText): TranscriptText {
  let safe = SAFE_TEXT_CACHE.get(text);
  if (safe === undefined) {
    safe = transcriptText(safeTerminalText(text.full));
    SAFE_TEXT_CACHE.set(text, safe);
  }
  return safe;
}

/** Terminal-safe head/tail slice of one text, with the hidden-line marker in
 *  between. */
export function elidedTextLines(
  text: TranscriptText,
  elide: boolean,
): string[] {
  const { head, tail, hiddenLines } = elideText(
    safeTranscriptText(text),
    elide
      ? { headLines: ROW_BODY_HEAD_LINES, tailLines: ROW_BODY_TAIL_LINES }
      : UNBOUNDED_BUDGET,
  );
  return hiddenLines === 0
    ? [...head, ...tail]
    : [
        ...head,
        `${hiddenRowsText(hiddenLines, 'lines')} (Ctrl-T to view full output)`,
        ...tail,
      ];
}

/** Open a block with the corner glyph and indent its continuation rows. */
function cornerBlock(lines: readonly string[]): string[] {
  return lines.map((line, index) =>
    index === 0 ? `${TOOL_OUTPUT_CORNER} ${line}` : `  ${line}`,
  );
}

function statItemLines(items: readonly StatItem[]): string[] {
  return items.map((item) => `${item.label}: ${item.value}`);
}

function fileListLines(row: Extract<TranscriptRow, { kind: 'fileList' }>) {
  const mediaByPath = new Map(row.media.map((ref) => [ref.path, ref.media]));
  return row.files.map((file) => {
    const media = mediaByPath.get(file.path);
    const marker = file.ok ? TICK : CROSS;
    const name = file.varName ? `${file.varName}: ` : '';
    const source = file.sourceDisplay ? ` (${file.sourceDisplay})` : '';
    const size = media
      ? ` [${media.kind}, ${formatBytes(media.sizeBytes)}]`
      : '';
    return `${marker} ${name}${file.path}${source}${size}`;
  });
}

/**
 * The rows a transcript entry paints beneath its headline. Returns terminal-
 * safe, unwrapped lines already carrying their corner/indent gutter; the
 * caller wraps them to its own width.
 */
export function transcriptRowBodyLines(
  row: TranscriptRow,
  elide: boolean,
): readonly string[] {
  const lines = ((): readonly string[] => {
    switch (row.kind) {
      case 'thinking':
      case 'scratchpad':
        return elidedTextLines(row.text, elide);
      case 'error':
        return elidedTextLines(row.detailText, elide);
      case 'fileList':
        return fileListLines(row);
      case 'missingOutputs':
        return [...row.missing, ...(row.xmlFile ? [row.xmlFile] : [])];
      case 'latexdiff':
        return row.entries.map(
          (entry) =>
            `${entry.status === 'success' ? TICK : CROSS} ${entry.displayName}${
              entry.message ? ` — ${entry.message}` : ''
            }`,
        );
      case 'statistics':
        return statItemLines(row.items);
      case 'contextManagement':
        return [
          ...statItemLines(row.items),
          ...(row.summary ? elidedTextLines(row.summary, elide) : []),
        ];
      case 'progressStatus':
        return row.detail ? elidedTextLines(row.detail, elide) : [];
      case 'assistant':
      case 'user':
      case 'tool':
      case 'webSearch':
      case 'workflowTask':
      case 'compactionActivity':
      case 'phase':
      case 'log':
        return [];
    }
  })();
  // One place for the terminal's defensive pass over producer text: control
  // sequences a terminal would execute.
  // Elided texts arrive sanitized; the list kinds carry producer text too
  // (paths, messages), so every line takes the (idempotent) pass here.
  return lines.length === 0
    ? lines
    : cornerBlock(lines.map((line) => safeTerminalText(line)));
}
