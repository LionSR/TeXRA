// CLI-native tool-call row.
//
// Renders a single TOOL_USE entry as one compact header line plus an
// optional indented output block (max 3 lines), mirroring the visual
// language Claude Code uses in its Ink TUI. Per-tool rich renderers
// (edit diffs, file links, ANSI bash output) live in the VS Code
// progress view; the CLI sticks to a universal renderer that works for
// every tool without dispatch tables.

import { Box, Text } from 'ink';

import type { NormalizedToolUse } from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';

const STATUS_DOT = '●';
const OUTPUT_CORNER = '⎿';
const MAX_OUTPUT_LINES = 3;
const MAX_HEADER_PREVIEW = 80;

function displayToolName(toolName: string): string {
  // Drop provider/handler prefixes like `claude:Bash` or `mcp:slack:send`
  // so the row reads as just the tool — `Bash`, `send`. Tools without a
  // colon are returned as-is.
  const lastColon = toolName.lastIndexOf(':');
  return lastColon >= 0 ? toolName.slice(lastColon + 1) : toolName;
}

function previewInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === undefined || input === null) return '';
  if (isPlainObject(input)) {
    // Heuristic: most tools have a primary "what" field. Show that
    // first; otherwise fall back to a compact JSON dump.
    const primary =
      (typeof input.command === 'string' && input.command) ||
      (typeof input.code === 'string' && input.code) ||
      (typeof input.path === 'string' && input.path) ||
      (typeof input.file_path === 'string' && input.file_path) ||
      (typeof input.query === 'string' && input.query) ||
      (typeof input.url === 'string' && input.url) ||
      '';
    if (primary) return primary;
    try {
      return JSON.stringify(input);
    } catch {
      return '';
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replaceAll(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function statusColor(toolUse: NormalizedToolUse): 'green' | 'red' | undefined {
  if (toolUse.isError) return 'red';
  if (toolUse.status === 'completed') return 'green';
  return undefined;
}

export function ToolUseRow({
  toolUse,
}: {
  readonly toolUse: NormalizedToolUse;
}): React.JSX.Element {
  const color = statusColor(toolUse);
  const name = displayToolName(toolUse.toolName) || 'tool';

  const previewSource =
    toolUse.headerSummary || previewInput(toolUse.input) || '';
  const preview = previewSource
    ? truncateOneLine(previewSource, MAX_HEADER_PREVIEW)
    : '';

  const outputLines = toolUse.outputText ? toolUse.outputText.split('\n') : [];
  const visibleOutput = outputLines.slice(0, MAX_OUTPUT_LINES);
  const hiddenCount = Math.max(0, outputLines.length - visibleOutput.length);

  const completed = toolUse.status === 'completed';
  const hasError = toolUse.isError && toolUse.errorText;
  // When a tool completes with neither output nor error, show "(no output)"
  // so the row doesn't look stuck. While running, we leave the body blank.
  const showNoOutput = completed && outputLines.length === 0 && !hasError;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" flexWrap="nowrap">
        <Text color={color} dimColor={!color}>
          {STATUS_DOT}{' '}
        </Text>
        <Text bold>{name}</Text>
        {preview ? <Text dimColor>{` (${preview})`}</Text> : null}
      </Box>
      {visibleOutput.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {visibleOutput.map((line, index) => (
            <Box key={index} flexDirection="row" flexWrap="nowrap">
              <Text dimColor>{index === 0 ? `${OUTPUT_CORNER} ` : '  '}</Text>
              <Text>{line}</Text>
            </Box>
          ))}
          {hiddenCount > 0 ? (
            <Text
              dimColor
            >{`  … +${hiddenCount} line${hiddenCount === 1 ? '' : 's'}`}</Text>
          ) : null}
        </Box>
      ) : null}
      {hasError ? (
        <Box flexDirection="row" flexWrap="nowrap" paddingLeft={2}>
          <Text dimColor>{`${OUTPUT_CORNER} `}</Text>
          <Text color="red">{truncateOneLine(toolUse.errorText, 240)}</Text>
        </Box>
      ) : null}
      {showNoOutput ? (
        <Box flexDirection="row" flexWrap="nowrap" paddingLeft={2}>
          <Text dimColor>{`${OUTPUT_CORNER} (no output)`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
