// Per-entry renderers shared by the `<Static>` finalized transcript and the
// bounded live region. Finalized assistant text flows through the ANSI
// markdown renderer; the live tail stays plain text to avoid re-parsing a
// growing document on every chunk.

import { Box, Text } from 'ink';

import { Markdown } from '../render/Markdown';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { fillRows } from '../render/terminalText';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import { ToolUseRow } from './ToolUseRow';
import { toolUseDisplayLines } from './toolRenderers';
import type { ConversationEntry } from '../state/cliState';

const INQUIRY_CONTINUATION_RE =
  /^\[inquiry\]\s+\S+\s+(?:answered|dropped by user)\.(?:\n|$)/;

export function isInquiryContinuationText(text: string): boolean {
  return INQUIRY_CONTINUATION_RE.test(text);
}

function prefixedWrappedLines(
  text: string,
  cols: number,
  prefix = '› ',
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
  prefix = '› ',
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
  width,
}: {
  readonly entry: ConversationEntry;
  readonly colorEnabled?: boolean;
  readonly width?: number;
}): React.JSX.Element {
  // Mark a user turn with a full-width reverse-video band (theme-adaptive via
  // reverse video). The fixed-width fill is baked at render width, so it only
  // stays full-width across a resize because `<Static>` is remounted on a width
  // change (key={columns} in StaticConversationTranscript) — that regenerates
  // `fullStaticOutput` at the new width, which the resize full-repaint then
  // reprints. The `› ` chevron is 2 cols, matching the static row count in
  // transcriptLines.ts.
  const cols = Math.max(1, Math.floor(width ?? 80));
  return (
    <Box>
      <Text inverse={colorEnabled !== false}>
        {compactPrefixedDisplayRows({
          fillWidth: true,
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
  width,
}: {
  readonly entry: ConversationEntry;
  readonly fillWidth?: boolean;
  readonly colorEnabled?: boolean;
  readonly width?: number;
}): React.JSX.Element {
  const cols = Math.max(1, Math.floor(width ?? 80));
  const lines = prefixedWrappedLines(entry.text, cols);
  const displayLines =
    fillWidth === true ? fillRows(lines.join('\n'), cols).split('\n') : lines;
  return (
    <Box flexDirection="column">
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
  readonly process: NonNullable<ConversationEntry['process']>;
  readonly width?: number;
}): React.JSX.Element {
  if (fillWidth === true) {
    const cols = Math.max(1, Math.floor(width ?? 80) - 2);
    return (
      <Box marginBottom={1} paddingX={1} flexDirection="column">
        <Text>
          {fillRows(completedProcessDisplayLines(process).join('\n'), cols)}
        </Text>
      </Box>
    );
  }

  const color = process.isError ? 'red' : 'green';
  const [, ...tailLines] = completedProcessDisplayLines(process);
  return (
    <Box marginBottom={1} paddingX={1} flexDirection="column">
      <Box>
        <Text color={color}>● </Text>
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

export function TranscriptEntry({
  entry,
  width,
  colorEnabled,
  fillWidth,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
  readonly colorEnabled?: boolean;
  readonly fillWidth?: boolean;
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
        <UserEntryRow entry={entry} colorEnabled={colorEnabled} width={width} />
      );
    case 'error': {
      const cols = Math.max(1, Math.floor(width ?? 80) - 2);
      return (
        <Box paddingX={1}>
          <Text color="red">
            {compactPrefixedDisplayRows({
              fillWidth,
              prefix: '! ',
              text: entry.text,
              width: cols,
            })}
          </Text>
        </Box>
      );
    }
    case 'tool':
      if (entry.toolUse) {
        return (
          <ToolUseRow
            fillWidth={fillWidth}
            toolUse={entry.toolUse}
            width={width}
          />
        );
      }
      break;
    case 'process':
      if (entry.process) {
        return (
          <ProcessEntryRow
            fillWidth={fillWidth}
            process={entry.process}
            width={width}
          />
        );
      }
      break;
  }
  return (
    <Box marginBottom={1}>
      <Markdown
        content={entry.text}
        width={width}
        colorEnabled={colorEnabled}
        fillWidth={fillWidth}
      />
    </Box>
  );
}

function boundedLines(
  lines: readonly string[],
  maxRows: number,
): readonly string[] {
  return lines.slice(-Math.max(1, maxRows));
}

// Slice raw text to a tail window before wrapping: ~2 screen widths per
// visible row covers worst-case wrapping without making the wrap O(text)
// on every streaming delta. Shared by the live renderers and the viewport
// row estimator so the cap stays consistent.
export function tailWindow(
  text: string,
  cols: number,
  tailRows: number,
): string {
  const budget = Math.max(1, cols) * tailRows * 2;
  return text.length > budget ? text.slice(-budget) : text;
}

function plainWrapTailLines(
  text: string,
  cols: number,
  tailRows: number,
): readonly string[] {
  const c = Math.max(1, cols);
  return wrapAnsiToWidth(tailWindow(text, c, tailRows), c)
    .split('\n')
    .slice(-Math.max(1, tailRows));
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
  const cols = Math.max(1, Math.floor(width ?? 80));
  if (!finalized) {
    return plainWrapTailLines(text, cols, rows);
  }
  return boundedLines(
    renderAnsiMarkdown(text, { width: cols, colorEnabled }).split('\n'),
    rows,
  );
}

export function BoundedTranscriptEntry({
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
    const cols = Math.max(1, Math.floor(width ?? 80));
    // Streaming overflow stays plain for speed. Finalized overflow is only
    // used by scoped child panes, so render cached Markdown first and then
    // take the visible tail.
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
  if (entry.role === 'tool' && entry.toolUse) {
    const cols = Math.max(1, Math.floor(width ?? 80) - 2);
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
  if (entry.role === 'process' && entry.process) {
    const cols = Math.max(1, Math.floor(width ?? 80) - 2);
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

  const prefix = entry.role === 'error' ? '! ' : '› ';
  const color = entry.role === 'error' ? 'red' : undefined;
  const cols = Math.max(1, Math.floor(width ?? 80) - 2);
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
}

// Cap the live tail so a multi-megabyte assistant buffer doesn't re-wrap
// every chunk. The static `<Static>` transcript owns the full history; we
// only need enough characters here to fill a typical viewport.
export const LIVE_TAIL_ROWS = 24;

export function LiveTranscriptEntry({
  entry,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
}): React.JSX.Element {
  const cols = Math.max(1, Math.floor(width ?? 80));
  const rows = plainWrapTailLines(entry.text, cols, LIVE_TAIL_ROWS);
  return (
    <Box flexDirection="column">
      <Text>{fillRows(rows.join('\n'), cols)}</Text>
    </Box>
  );
}
