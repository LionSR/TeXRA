// CLI-native tool-call row.
//
// Renders a single TOOL_USE entry as one compact header line plus an
// optional indented output block (max 3 lines), mirroring the visual
// language Claude Code uses in its Ink TUI. Per-tool rich renderers
// (edit diffs, file links, ANSI bash output) live in the VS Code
// progress view; the CLI sticks to a universal renderer that works for
// every tool without dispatch tables.

import { useMemo } from 'react';

import { Box, Text } from 'ink';

import type { NormalizedToolUse } from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

const STATUS_DOT = '●';
const OUTPUT_CORNER = '⎿';
const MAX_OUTPUT_LINES = 3;
const MAX_HEADER_PREVIEW = 80;
const MAX_ERROR_PREVIEW = 240;

// Tool inputs vary in shape; show whichever of these "primary" fields
// exists first. Order matters — earlier keys win.
const PRIMARY_INPUT_KEYS = [
  'command',
  'code',
  'path',
  'file_path',
  'query',
  'url',
] as const;

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
    for (const key of PRIMARY_INPUT_KEYS) {
      const value = input[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
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

  // Memoize by toolUse identity. subscribeStreamLog's data-ref cache
  // keeps `toolUse` stable across re-renders when nothing changed, so
  // the heavy work (split, slice, JSON.stringify in previewInput) only
  // runs when there's a real update.
  const { preview, visibleOutput, hiddenCount } = useMemo(() => {
    const sourceText =
      toolUse.headerSummary || previewInput(toolUse.input) || '';
    const previewText = sourceText
      ? truncateWithEllipsis(collapseWhitespace(sourceText), MAX_HEADER_PREVIEW)
      : '';
    const lines = toolUse.outputText ? toolUse.outputText.split('\n') : [];
    const visible = lines.slice(0, MAX_OUTPUT_LINES);
    return {
      preview: previewText,
      visibleOutput: visible,
      hiddenCount: Math.max(0, lines.length - visible.length),
    };
  }, [toolUse]);

  // `isError` is the authoritative signal — `errorText` can be empty even
  // when the upstream payload sets `isError: true` (no `error` string).
  // Tracking only the text would let the "(no output)" branch fire on a
  // failed tool, hiding the failure behind a misleading label.
  const errorText = toolUse.isError ? toolUse.errorText || '(error)' : '';
  const showError = toolUse.isError;
  const showNoOutput =
    toolUse.status === 'completed' && visibleOutput.length === 0 && !showError;

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
      {showError ? (
        <Box flexDirection="row" flexWrap="nowrap" paddingLeft={2}>
          <Text dimColor>{`${OUTPUT_CORNER} `}</Text>
          <Text color="red">
            {truncateWithEllipsis(
              collapseWhitespace(errorText),
              MAX_ERROR_PREVIEW,
            )}
          </Text>
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
