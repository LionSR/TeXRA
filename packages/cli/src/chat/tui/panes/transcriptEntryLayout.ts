// Declarative conversation-entry geometry shared by Ink renderers, viewport
// budgeting, static scrollback, and the plain-text transcript viewer.

import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import {
  ERROR_ENTRY_PREFIX,
  TOOL_OUTPUT_CORNER,
  USER_ENTRY_PREFIX,
} from '../ui/glyphs';
import { isInquiryContinuationText } from './transcriptEntries';
import { toolUseDisplayLines, toolUseMarginBottomRows } from './toolRenderers';
import type { ConversationEntry } from '../state/cliState';

const DEFAULT_TRANSCRIPT_COLUMNS = 80;
const USER_ENTRY_MARGIN_TOP_ROWS = 1;
const USER_ENTRY_MARGIN_BOTTOM_ROWS = 1;
const ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS = 0;
const PROCESS_ENTRY_MARGIN_BOTTOM_ROWS = 1;
export const LIVE_TAIL_ROWS = 24;

type TranscriptEntryRole = ConversationEntry['role'];
type TranscriptEntryLayoutMode =
  'bounded' | 'live' | 'scrollback' | 'scrollback-budget' | 'viewer';

interface RoleGeometry {
  readonly firstPrefix: string;
  readonly continuationPrefix: string;
  readonly inset: number;
  readonly marginBottomRows: number;
  readonly marginTopRows: number;
}

const ROLE_GEOMETRY = {
  assistant: {
    firstPrefix: '',
    continuationPrefix: '',
    inset: 0,
    marginBottomRows: ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS,
    marginTopRows: 0,
  },
  error: {
    firstPrefix: ERROR_ENTRY_PREFIX,
    continuationPrefix: ' '.repeat(ERROR_ENTRY_PREFIX.length),
    inset: 2,
    marginBottomRows: 0,
    marginTopRows: 0,
  },
  process: {
    firstPrefix: '',
    continuationPrefix: '',
    inset: 2,
    marginBottomRows: PROCESS_ENTRY_MARGIN_BOTTOM_ROWS,
    marginTopRows: 0,
  },
  tool: {
    firstPrefix: '',
    continuationPrefix: '',
    inset: 0,
    marginBottomRows: 0,
    marginTopRows: 0,
  },
  user: {
    firstPrefix: USER_ENTRY_PREFIX,
    continuationPrefix: ' '.repeat(USER_ENTRY_PREFIX.length),
    inset: 2,
    marginBottomRows: USER_ENTRY_MARGIN_BOTTOM_ROWS,
    marginTopRows: USER_ENTRY_MARGIN_TOP_ROWS,
  },
} as const satisfies Record<TranscriptEntryRole, RoleGeometry>;

export interface TranscriptEntryLayout extends RoleGeometry {
  readonly columns: number;
  readonly lines: readonly string[];
  readonly role: TranscriptEntryRole;
}

export function transcriptColumns(
  width: number | undefined,
  inset = 0,
): number {
  return Math.max(
    1,
    Math.floor(
      width == null || !Number.isFinite(width)
        ? DEFAULT_TRANSCRIPT_COLUMNS
        : width,
    ) - inset,
  );
}

function wrapWithPrefix(
  body: string,
  columns: number,
  firstPrefix: string,
  continuationPrefix: string,
): readonly string[] {
  const width = Math.max(1, columns - firstPrefix.length);
  return wrapAnsiToWidth(body, width)
    .split('\n')
    .map(
      (line, index) =>
        `${index === 0 ? firstPrefix : continuationPrefix}${line}`,
    );
}

const CORNER_PREFIX = `${TOOL_OUTPUT_CORNER} `;

function leadingWhitespacePrefix(line: string): string {
  return line.match(/^\s+/)?.[0] ?? '';
}

function wrapDisplayLine(line: string, columns: number): readonly string[] {
  if (line.startsWith(CORNER_PREFIX)) {
    return wrapWithPrefix(
      line.slice(CORNER_PREFIX.length),
      columns,
      CORNER_PREFIX,
      ' '.repeat(CORNER_PREFIX.length),
    );
  }
  const prefix = leadingWhitespacePrefix(line);
  return wrapWithPrefix(line.slice(prefix.length), columns, prefix, prefix);
}

function wrapDisplayLines(
  lines: readonly string[],
  columns: number,
): readonly string[] {
  return lines.flatMap((line) => wrapDisplayLine(line, columns));
}

function tailWindow(text: string, columns: number, tailRows: number): string {
  const budget = Math.max(1, columns) * tailRows * 2;
  return text.length > budget ? text.slice(-budget) : text;
}

export function liveAssistantDisplayLines({
  rows,
  text,
  width,
}: {
  readonly rows: number;
  readonly text: string;
  readonly width?: number;
}): readonly string[] {
  const columns = transcriptColumns(width);
  return wrapAnsiToWidth(tailWindow(text, columns, rows), columns)
    .split('\n')
    .slice(-Math.max(1, rows));
}

function entryLines(
  entry: ConversationEntry,
  mode: TranscriptEntryLayoutMode,
  columns: number,
  colorEnabled: boolean | undefined,
  maxRows: number | undefined,
): readonly string[] {
  switch (entry.role) {
    case 'assistant':
      if (mode === 'live' || (mode === 'bounded' && !entry.finalized)) {
        return liveAssistantDisplayLines({
          rows:
            mode === 'bounded' && maxRows !== undefined
              ? Math.max(1, maxRows)
              : LIVE_TAIL_ROWS,
          text: entry.text,
          width: columns,
        });
      }
      return mode === 'scrollback' ||
        mode === 'scrollback-budget' ||
        mode === 'bounded'
        ? renderAnsiMarkdown(entry.text, {
            width: columns,
            colorEnabled,
          }).split('\n')
        : wrapWithPrefix(entry.text, columns, '', '');
    case 'tool': {
      const lines = toolUseDisplayLines(entry.toolUse, {
        elide: mode !== 'viewer' && mode !== 'scrollback-budget',
      });
      // Rich rows and their bounded fallback keep each display line on one
      // terminal row. Other modes paint the wrapped text projection directly.
      return mode === 'live' || mode === 'bounded'
        ? lines
        : wrapDisplayLines(lines, columns);
    }
    case 'process': {
      const lines = completedProcessDisplayLines(entry.process);
      return mode === 'live' || mode === 'bounded'
        ? lines
        : wrapDisplayLines(lines, columns);
    }
    default: {
      const geometry = ROLE_GEOMETRY[entry.role];
      return wrapWithPrefix(
        entry.text,
        columns,
        geometry.firstPrefix,
        geometry.continuationPrefix,
      );
    }
  }
}

export function transcriptEntryLayout(
  entry: ConversationEntry,
  {
    colorEnabled,
    maxRows,
    mode = 'scrollback',
    width,
  }: {
    readonly colorEnabled?: boolean;
    readonly maxRows?: number;
    readonly mode?: TranscriptEntryLayoutMode;
    readonly width?: number;
  } = {},
): TranscriptEntryLayout {
  const base = ROLE_GEOMETRY[entry.role];
  // The bounded tool fallback historically uses a one-column Ink gutter; the
  // rich unbounded tool renderer owns its own per-line indentation.
  const inset = entry.role === 'tool' && mode === 'bounded' ? 2 : base.inset;
  const isInquiryContinuation =
    entry.role === 'user' && isInquiryContinuationText(entry.text);
  const marginTopRows = isInquiryContinuation ? 0 : base.marginTopRows;
  const marginBottomRows =
    entry.role === 'tool'
      ? toolUseMarginBottomRows(entry.toolUse)
      : isInquiryContinuation
        ? 0
        : base.marginBottomRows;
  // The ctrl+t viewer is a full-width text projection with no Ink padding;
  // its lines still share role prefixes and wrapping rules with the layout.
  const columns = transcriptColumns(width, mode === 'viewer' ? 0 : inset);
  return {
    ...base,
    columns,
    lines: entryLines(entry, mode, columns, colorEnabled, maxRows),
    inset,
    marginBottomRows,
    marginTopRows,
    role: entry.role,
  };
}

export function transcriptEntryLayoutRows(
  layout: TranscriptEntryLayout,
): number {
  return (
    Math.max(1, layout.lines.length) +
    layout.marginTopRows +
    layout.marginBottomRows
  );
}

export function boundedTranscriptEntryLayout(
  layout: TranscriptEntryLayout,
  maxRows: number,
): TranscriptEntryLayout {
  const rows = Math.max(1, maxRows);
  // Existing bounded process/tool rows omit their unbounded separators; user
  // bands retain margins whenever one content row still fits.
  const marginRows =
    layout.role === 'user' ? layout.marginTopRows + layout.marginBottomRows : 0;
  const includeMargins = rows > marginRows;
  const contentRows = Math.max(1, rows - (includeMargins ? marginRows : 0));
  return {
    ...layout,
    lines: layout.lines.slice(-contentRows),
    marginBottomRows:
      layout.role === 'user' && includeMargins ? layout.marginBottomRows : 0,
    marginTopRows:
      layout.role === 'user' && includeMargins ? layout.marginTopRows : 0,
  };
}
