// Per-entry renderers shared by the `<Static>` finalized transcript and the
// bounded live region. Finalized assistant text flows through the ANSI
// markdown renderer; the live tail stays plain text to avoid re-parsing a
// growing document on every chunk.

import { Box, Text } from 'ink';

import { Markdown } from '../render/Markdown';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import type { ConversationEntry } from '../state/cliState';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import { ToolUseRow } from './ToolUseRow';
import { toolUseDisplayLines } from './toolRenderers';

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
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
}): React.JSX.Element {
  switch (entry.role) {
    case 'user':
      return (
        <Box paddingX={1}>
          <Text dimColor>› </Text>
          <Text>{entry.text}</Text>
        </Box>
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
      <Markdown content={entry.text} width={width} />
    </Box>
  );
}

function boundedLines(
  lines: readonly string[],
  maxRows: number,
): readonly string[] {
  return lines.slice(-Math.max(1, maxRows));
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
    const rendered = renderAnsiMarkdown(entry.text, { width });
    return (
      <Box flexDirection="column">
        <Text>{boundedLines(rendered.split('\n'), rows).join('\n')}</Text>
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

export function LiveTranscriptEntry({
  entry,
  width,
}: {
  readonly entry: ConversationEntry;
  readonly width?: number;
}): React.JSX.Element {
  const cols = width ?? 80;
  const rows = wrapAnsiToWidth(entry.text, cols).split('\n');
  return (
    <Box flexDirection="column">
      <Text>{rows.join('\n')}</Text>
    </Box>
  );
}
