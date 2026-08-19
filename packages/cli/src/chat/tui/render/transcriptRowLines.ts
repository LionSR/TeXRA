// Terminal paint of a shared transcript row's body.
//
// `@shared/transcript` carries every text untruncated plus the measurements
// needed to elide it; this module is where the terminal spends its own budget
// — a head/tail line slice with a `+N lines` marker, and a terminal-safe pass
// over text a producer wrote. Nothing here truncates the model.

import { safeTerminalText } from '@cli/runtime/terminalText';
import { TOOL_OUTPUT_CORNER } from '@cli/tui/ui/glyphs';
import { redactSecrets } from '@logger/redaction';
import {
  elideText,
  type StatItem,
  type TranscriptRow,
  type TranscriptText,
} from '@shared/transcript';
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

/** Head/tail slice of one text, with the hidden-line marker in between. */
export function elidedTextLines(
  text: TranscriptText,
  elide: boolean,
): string[] {
  const { head, tail, hiddenLines } = elideText(
    text,
    elide
      ? { headLines: ROW_BODY_HEAD_LINES, tailLines: ROW_BODY_TAIL_LINES }
      : UNBOUNDED_BUDGET,
  );
  return hiddenLines === 0
    ? [...head, ...tail]
    : [
        ...head,
        `… +${hiddenLines} lines (Ctrl-T to view full output)`,
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
    const marker = file.ok ? '✓' : '✗';
    const name = file.varName ? `${file.varName}: ` : '';
    const source = file.sourceDisplay ? ` (${file.sourceDisplay})` : '';
    const size = media
      ? ` [${media.kind}, ${formatBytes(media.sizeBytes)}]`
      : '';
    return `${marker} ${name}${file.path}${source}${size}`;
  });
}

function webSearchLines(
  row: Extract<TranscriptRow, { kind: 'webSearch' }>,
): string[] {
  return row.results.map((result) => {
    const title = result.title ?? result.url ?? '(untitled)';
    const domain = result.domain ? ` — ${result.domain}` : '';
    return `${title}${domain}`;
  });
}

function webFetchLines(
  row: Extract<TranscriptRow, { kind: 'webFetch' }>,
  elide: boolean,
): string[] {
  const lines: string[] = [];
  if (row.title) lines.push(row.title);
  if (row.url) lines.push(row.url);
  if (row.errorLabel) lines.push(row.errorLabel);
  if (row.content) lines.push(...elidedTextLines(row.content, elide));
  return lines;
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
            `${entry.status === 'success' ? '✓' : '✗'} ${entry.displayName}${
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
      case 'webSearch':
        return webSearchLines(row);
      case 'webFetch':
        return webFetchLines(row, elide);
      case 'assistant':
      case 'user':
      case 'tool':
      case 'workflowTask':
      case 'compactionActivity':
      case 'contextState':
      case 'phase':
      case 'log':
        return [];
    }
  })();
  // One place for the terminal's two defensive passes over producer text:
  // control sequences a terminal would execute, and credential shapes the
  // recorder's redaction did not already cover (a raw provider error body
  // reaches this row verbatim).
  return lines.length === 0
    ? lines
    : cornerBlock(lines.map((line) => redactSecrets(safeTerminalText(line))));
}
