// Per-entry renderers shared by the `<Static>` finalized transcript and the
// bounded live region. Finalized assistant text flows through the ANSI
// markdown renderer; the live tail stays plain text to avoid re-parsing a
// growing document on every chunk.

import { memo } from 'react';
import { Box, Text } from 'ink';

import { Markdown } from '../render/Markdown';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { fillRows } from '../render/terminalText';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import {
  ERROR_ENTRY_PREFIX,
  STATUS_DOT,
  USER_ENTRY_PREFIX,
} from '../ui/glyphs';
import { isInquiryContinuationText } from './transcriptEntries';
import { ToolUseRow } from './ToolUseRow';
import { toolUseDisplayLines } from './toolRenderers';
import type {
  CompletedProcessTranscript,
  ConversationEntry,
} from '../state/cliState';

export const USER_ENTRY_MARGIN_TOP_ROWS = 1;
export const USER_ENTRY_MARGIN_BOTTOM_ROWS = 1;
export const ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS = 0;
export const PROCESS_ENTRY_MARGIN_BOTTOM_ROWS = 1;

// Terminal columns available to an entry's text. Padded boxes (paddingX={1})
// inset one column on each side, so those rows pass `inset = 2`; full-width
// rows pass no inset. A missing width defaults to 80 columns.
function entryCols(width: number | undefined, inset = 0): number {
  return Math.max(1, Math.floor(width ?? 80) - inset);
}

function prefixedWrappedLines(
  text: string,
  cols: number,
  prefix = USER_ENTRY_PREFIX,
): readonly string[] {
  const continuationPrefix = ' '.repeat(prefix.length);
  return wrapAnsiToWidth(text, Math.max(1, cols - prefix.length))
    .split('\n')
    .map(
      (line, index) => `${index === 0 ? prefix : continuationPrefix}${line}`,
    );
}

function displayRows({
  lines,
  fillWidth,
  width,
}: {
  readonly lines: readonly string[];
  readonly fillWidth?: boolean;
  readonly width: number;
}): string {
  const text = lines.join('\n');
  return fillWidth === true ? fillRows(text, width) : text;
}

export function compactPrefixedDisplayRows({
  fillWidth,
  maxRows,
  prefix = USER_ENTRY_PREFIX,
  text,
  width,
}: {
  readonly fillWidth?: boolean;
  readonly maxRows?: number;
  readonly prefix?: string;
  readonly text: string;
  readonly width: number;
}): string {
  const cols = Math.max(1, Math.floor(width));
  const lines = prefixedWrappedLines(text, cols, prefix);
  return displayRows({
    fillWidth,
    lines: maxRows === undefined ? lines : boundedLines(lines, maxRows),
    width: cols,
  });
}

function boundedDisplayRows({
  lines,
  maxRows,
  width,
}: {
  readonly lines: readonly string[];
  readonly maxRows: number;
  readonly width: number;
}): string {
  return fillRows(boundedLines(lines, maxRows).join('\n'), width);
}

function UserEntryRow({
  entry,
  colorEnabled,
  marginTopRows = USER_ENTRY_MARGIN_TOP_ROWS,
  marginBottomRows = USER_ENTRY_MARGIN_BOTTOM_ROWS,
  maxRows,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly colorEnabled?: boolean;
  readonly marginTopRows?: number;
  readonly marginBottomRows?: number;
  readonly maxRows?: number;
  readonly width?: number;
}): React.JSX.Element {
  // Mark a user turn with a reverse-video band (theme-adaptive via reverse
  // video), inset one column from each terminal edge — the same gutter the
  // error/tool/process rows get from their padded boxes — with a blank row
  // above and below so the turn breathes. Finalized transcript rows are
  // normally print-once; a width change remounts the enclosing `<Static>` so
  // patched Ink replaces the accumulated rows at the current width. The `› `
  // chevron is 2 cols; row estimators add the exported margin constants
  // alongside their wrapped-line count.
  const cols = entryCols(width, 2);
  return (
    <Box marginTop={marginTopRows} marginBottom={marginBottomRows} paddingX={1}>
      <Text inverse={colorEnabled !== false}>
        {compactPrefixedDisplayRows({
          fillWidth: true,
          maxRows,
          text: entry.text,
          width: cols,
        })}
      </Text>
    </Box>
  );
}

function InquiryContinuationRow({
  entry,
  fillWidth,
  colorEnabled,
  maxRows,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly fillWidth?: boolean;
  readonly colorEnabled?: boolean;
  readonly maxRows?: number;
  readonly width?: number;
}): React.JSX.Element {
  // Same one-column gutter as the user band so both `› ` chevrons align.
  const cols = entryCols(width, 2);
  const wrappedLines = prefixedWrappedLines(entry.text, cols);
  const lines =
    maxRows === undefined ? wrappedLines : boundedLines(wrappedLines, maxRows);
  const displayLines =
    fillWidth === true ? fillRows(lines.join('\n'), cols).split('\n') : lines;
  return (
    <Box flexDirection="column" paddingX={1}>
      {displayLines.map((line, index) => (
        <Text
          key={index}
          color={colorEnabled !== false && index === 0 ? 'cyan' : undefined}
          dimColor={colorEnabled !== false && index > 0}
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}

function ProcessEntryRow({
  fillWidth,
  process,
  width,
}: {
  readonly fillWidth?: boolean;
  readonly process: CompletedProcessTranscript;
  readonly width?: number;
}): React.JSX.Element {
  if (fillWidth === true) {
    const cols = entryCols(width, 2);
    return (
      <Box
        marginBottom={PROCESS_ENTRY_MARGIN_BOTTOM_ROWS}
        paddingX={1}
        flexDirection="column"
      >
        <Text>
          {fillRows(completedProcessDisplayLines(process).join('\n'), cols)}
        </Text>
      </Box>
    );
  }

  const color = process.isError ? 'red' : 'green';
  const [, ...tailLines] = completedProcessDisplayLines(process);
  return (
    <Box
      marginBottom={PROCESS_ENTRY_MARGIN_BOTTOM_ROWS}
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text color={color}>{STATUS_DOT} </Text>
        <Text>{process.title}</Text>
        {process.status ? <Text dimColor>{` · ${process.status}`}</Text> : null}
        {process.elapsed ? (
          <Text dimColor>{` · ${process.elapsed}`}</Text>
        ) : null}
        {process.isError ? <Text color="red"> · error</Text> : null}
      </Box>
      {process.tailLines.length > 0 ? (
        <Box marginLeft={2} flexDirection="column">
          {tailLines.map((line, index) => (
            <Text
              key={index}
              color={process.isError ? 'red' : undefined}
              dimColor={!process.isError}
            >
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

// The entry renderers are memoized: stream sync keeps unchanged entry
// objects reference-identical across ticks (see `renderLogEntry`'s
// `entriesEqual` reuse), so a streaming delta re-wraps only the entry that
// actually changed instead of every pending row on each 16ms tick.
export const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  width,
  colorEnabled,
  fillWidth,
  userBottomMarginRows,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
  readonly colorEnabled?: boolean;
  readonly fillWidth?: boolean;
  readonly userBottomMarginRows?: number;
}): React.JSX.Element {
  switch (entry.role) {
    case 'user':
      if (isInquiryContinuationText(entry.text)) {
        return (
          <InquiryContinuationRow
            entry={entry}
            fillWidth={fillWidth}
            colorEnabled={colorEnabled}
            width={width}
          />
        );
      }
      return (
        <UserEntryRow
          entry={entry}
          colorEnabled={colorEnabled}
          marginBottomRows={userBottomMarginRows}
          width={width}
        />
      );
    case 'error': {
      const cols = entryCols(width, 2);
      return (
        <Box paddingX={1}>
          <Text color="red">
            {compactPrefixedDisplayRows({
              fillWidth,
              prefix: ERROR_ENTRY_PREFIX,
              text: entry.text,
              width: cols,
            })}
          </Text>
        </Box>
      );
    }
    case 'tool':
      return (
        <ToolUseRow
          fillWidth={fillWidth}
          toolUse={entry.toolUse}
          width={width}
        />
      );
    case 'process':
      return (
        <ProcessEntryRow
          fillWidth={fillWidth}
          process={entry.process}
          width={width}
        />
      );
  }
  return (
    <Box marginBottom={ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS}>
      <Markdown
        content={entry.text}
        width={width}
        colorEnabled={colorEnabled}
        fillWidth={fillWidth}
      />
    </Box>
  );
});

function boundedLines(
  lines: readonly string[],
  maxRows: number,
): readonly string[] {
  return lines.slice(-Math.max(1, maxRows));
}

// Slice raw text to a tail window before wrapping: ~2 screen widths per
// visible row covers worst-case wrapping without making the wrap O(text) on
// every streaming delta. liveAssistantDisplayLines applies this window and is
// shared by the live renderers and viewport row estimator.
function tailWindow(text: string, cols: number, tailRows: number): string {
  const budget = Math.max(1, cols) * tailRows * 2;
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
  const cols = entryCols(width);
  return wrapAnsiToWidth(tailWindow(text, cols, rows), cols)
    .split('\n')
    .slice(-Math.max(1, rows));
}

export function boundedAssistantDisplayLines({
  colorEnabled,
  finalized,
  rows,
  text,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly finalized: boolean;
  readonly rows: number;
  readonly text: string;
  readonly width?: number;
}): readonly string[] {
  const cols = entryCols(width);
  if (!finalized) {
    return liveAssistantDisplayLines({ rows, text, width: cols });
  }
  return boundedLines(
    renderAnsiMarkdown(text, { width: cols, colorEnabled }).split('\n'),
    rows,
  );
}

export const BoundedTranscriptEntry = memo(function BoundedTranscriptEntry({
  colorEnabled,
  entry,
  maxRows,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly entry: ConversationEntry;
  readonly maxRows: number;
  readonly width?: number;
}): React.JSX.Element {
  const rows = Math.max(1, maxRows);
  if (entry.role === 'assistant') {
    const cols = entryCols(width);
    // Streaming overflow stays plain for speed. Finalized overflow renders
    // cached Markdown first and then takes the visible tail.
    return (
      <Box flexDirection="column">
        <Text>
          {displayRows({
            fillWidth: true,
            lines: boundedAssistantDisplayLines({
              colorEnabled,
              finalized: entry.finalized,
              rows,
              text: entry.text,
              width: cols,
            }),
            width: cols,
          })}
        </Text>
      </Box>
    );
  }
  if (entry.role === 'user') {
    if (isInquiryContinuationText(entry.text)) {
      return (
        <InquiryContinuationRow
          entry={entry}
          fillWidth
          colorEnabled={colorEnabled}
          maxRows={rows}
          width={width}
        />
      );
    }

    const includeMargins = rows >= 3;
    const marginRows = includeMargins
      ? USER_ENTRY_MARGIN_TOP_ROWS + USER_ENTRY_MARGIN_BOTTOM_ROWS
      : 0;
    return (
      <UserEntryRow
        entry={entry}
        colorEnabled={colorEnabled}
        marginTopRows={includeMargins ? USER_ENTRY_MARGIN_TOP_ROWS : 0}
        marginBottomRows={includeMargins ? USER_ENTRY_MARGIN_BOTTOM_ROWS : 0}
        maxRows={Math.max(1, rows - marginRows)}
        width={width}
      />
    );
  }
  if (entry.role === 'tool') {
    const cols = entryCols(width, 2);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          {boundedDisplayRows({
            lines: toolUseDisplayLines(entry.toolUse),
            maxRows: rows,
            width: cols,
          })}
        </Text>
      </Box>
    );
  }
  if (entry.role === 'process') {
    const cols = entryCols(width, 2);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          {boundedDisplayRows({
            lines: completedProcessDisplayLines(entry.process),
            maxRows: rows,
            width: cols,
          })}
        </Text>
      </Box>
    );
  }

  const prefix =
    entry.role === 'error' ? ERROR_ENTRY_PREFIX : USER_ENTRY_PREFIX;
  const color = entry.role === 'error' ? 'red' : undefined;
  const cols = entryCols(width, 2);
  return (
    <Box paddingX={1}>
      <Text color={color}>
        {compactPrefixedDisplayRows({
          fillWidth: true,
          maxRows: rows,
          prefix,
          text: entry.text,
          width: cols,
        })}
      </Text>
    </Box>
  );
});

// Cap the live tail so a multi-megabyte assistant buffer doesn't re-wrap
// every chunk. The static `<Static>` transcript owns the full history; we
// only need enough characters here to fill a typical viewport.
export const LIVE_TAIL_ROWS = 24;

export const LiveTranscriptEntry = memo(function LiveTranscriptEntry({
  entry,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
}): React.JSX.Element {
  const cols = entryCols(width);
  const rows = liveAssistantDisplayLines({
    rows: LIVE_TAIL_ROWS,
    text: entry.text,
    width: cols,
  });
  return (
    <Box flexDirection="column">
      <Text>{fillRows(rows.join('\n'), cols)}</Text>
    </Box>
  );
});
