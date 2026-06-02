// Per-entry renderers shared by the `<Static>` finalized transcript and the
// bounded live region. Finalized assistant text flows through the ANSI
// markdown renderer; the live tail stays plain text to avoid re-parsing a
// growing document on every chunk.

import { Box, Text } from 'ink';

import { Markdown } from '../render/Markdown';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import { ToolUseRow } from './ToolUseRow';
import { toolUseDisplayLines } from './toolRenderers';
import type { ConversationEntry } from '../state/cliState';

function UserEntryRow({
  entry,
  colorEnabled,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly colorEnabled?: boolean;
  readonly width?: number;
}): React.JSX.Element {
  // Mark a user turn with a reverse-video highlight so it stands out in
  // scrollback against the assistant's `●` rows. Reverse video (not a fixed
  // color) adapts to the terminal theme automatically — a light bar with dark
  // text on a dark terminal, the inverse on a light one — using the terminal's
  // own foreground/background. The highlight hugs the text (no width padding)
  // so it stays correct across a resize: a fixed-width fill gets baked into the
  // printed scrollback line and can't reflow, leaving a dead bar at the old
  // width when the terminal widens. The `› ` chevron is 2 cols, matching the
  // static row count in transcriptLines.ts.
  const cols = Math.max(1, Math.floor(width ?? 80));
  const body = wrapAnsiToWidth(entry.text, Math.max(1, cols - 2))
    .split('\n')
    .map((line, index) => `${index === 0 ? '› ' : '  '}${line}`)
    .join('\n');
  // No-color terminals can't show the reverse-video band; the `› ` marker still
  // distinguishes the turn, so only the `inverse` attribute differs.
  return (
    <Box>
      <Text inverse={colorEnabled !== false}>{body}</Text>
    </Box>
  );
}

function ProcessEntryRow({
  process,
}: {
  readonly process: NonNullable<ConversationEntry['process']>;
}): React.JSX.Element {
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
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
  readonly colorEnabled?: boolean;
}): React.JSX.Element {
  switch (entry.role) {
    case 'user':
      return (
        <UserEntryRow entry={entry} colorEnabled={colorEnabled} width={width} />
      );
    case 'error':
      return (
        <Box paddingX={1}>
          <Text color="red">! </Text>
          <Text color="red">{entry.text}</Text>
        </Box>
      );
    case 'tool':
      if (entry.toolUse) return <ToolUseRow toolUse={entry.toolUse} />;
      break;
    case 'process':
      if (entry.process) return <ProcessEntryRow process={entry.process} />;
      break;
  }
  return (
    <Box marginBottom={1}>
      <Markdown
        content={entry.text}
        width={width}
        colorEnabled={colorEnabled}
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

export function BoundedTranscriptEntry({
  entry,
  maxRows,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly maxRows: number;
  readonly width?: number;
}): React.JSX.Element {
  const rows = Math.max(1, maxRows);
  if (entry.role === 'assistant') {
    // In-flight overflow tail (still streaming): plain tail wrap rather
    // than renderAnsiMarkdown over the full buffer (O(text^2), and the
    // tail slice discards markdown structure above it anyway). Finalized
    // entries still render full markdown through `<Static>`.
    return (
      <Box flexDirection="column">
        <Text>
          {plainWrapTailLines(entry.text, width ?? 80, rows).join('\n')}
        </Text>
      </Box>
    );
  }
  if (entry.role === 'tool' && entry.toolUse) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          {boundedLines(toolUseDisplayLines(entry.toolUse), rows).join('\n')}
        </Text>
      </Box>
    );
  }
  if (entry.role === 'process' && entry.process) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          {boundedLines(completedProcessDisplayLines(entry.process), rows).join(
            '\n',
          )}
        </Text>
      </Box>
    );
  }

  const prefix = entry.role === 'error' ? '! ' : '› ';
  const color = entry.role === 'error' ? 'red' : undefined;
  const cols = Math.max(1, (width ?? 80) - prefix.length - 2);
  const lines = wrapAnsiToWidth(entry.text, cols).split('\n');
  return (
    <Box paddingX={1}>
      <Text color={color}>
        {boundedLines(lines, rows)
          .map((line, index) => `${index === 0 ? prefix : '  '}${line}`)
          .join('\n')}
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
  const rows = plainWrapTailLines(entry.text, width ?? 80, LIVE_TAIL_ROWS);
  return (
    <Box flexDirection="column">
      <Text>{rows.join('\n')}</Text>
    </Box>
  );
}
