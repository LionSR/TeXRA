// Third-party imports
import { useMemo } from 'react';

import { Box, Text } from 'ink';

// Local imports - shared schemas and utilities
import { TOOL_USE_STATUS, type NormalizedToolUse } from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';
import {
  collapseWhitespace,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';

// Local imports - CLI TUI rendering
import {
  DiffView,
  diffDisplayLines,
  editPatchGroups,
  type InlinePatchGroup,
} from '../render/DiffView';

const STATUS_DOT = '●';
const OUTPUT_CORNER = '⎿';
const MAX_OUTPUT_LINES = 3;
const MAX_PATCH_LINES = 10;
const MAX_HEADER_PREVIEW = 80;
const MAX_ERROR_PREVIEW = 240;

// Tool inputs vary in shape; show whichever of these "primary" fields
// exists first. Order matters: earlier keys win.
const PRIMARY_INPUT_KEYS = [
  'command',
  'code',
  'path',
  'file_path',
  'query',
  'url',
] as const;

export interface ToolRenderer {
  readonly key: string;
  matches(toolUse: NormalizedToolUse): boolean;
  render(toolUse: NormalizedToolUse): React.JSX.Element;
  displayLines(toolUse: NormalizedToolUse): readonly string[];
}

function lastSegmentToolName(toolName: string): string {
  // Drop provider/handler prefixes like `claude:Bash` so non-MCP tools
  // keep the historical compact label.
  const lastColon = toolName.lastIndexOf(':');
  return lastColon >= 0 ? toolName.slice(lastColon + 1) : toolName;
}

function displayToolName(toolName: string): string {
  return displayMcpToolName(toolName) ?? lastSegmentToolName(toolName);
}

function displayMcpToolName(toolName: string): string | undefined {
  const parts = toolName.split(':').filter(Boolean);
  if (parts.length < 3 || parts[0].toLowerCase() !== 'mcp') {
    return undefined;
  }
  return `${parts[1]}/${parts.slice(2).join(':')}`;
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

function statusColor(toolUse: NormalizedToolUse): 'green' | 'red' | undefined {
  if (toolUse.isError) return 'red';
  if (toolUse.status === TOOL_USE_STATUS.COMPLETED) return 'green';
  return undefined;
}

function isEditLikeTool(toolName: string): boolean {
  const name = lastSegmentToolName(toolName).toLowerCase();
  return (
    name === 'edit' ||
    name === 'multiedit' ||
    name.includes('str_replace') ||
    name.includes('text_editor')
  );
}

function toolUsePatchGroups(
  toolUse: NormalizedToolUse,
): readonly InlinePatchGroup[] | undefined {
  if (toolUse.isError || !isEditLikeTool(toolUse.toolName)) return undefined;
  return editPatchGroups(toolUse.input);
}

export function toolUsePatchDisplayLines(
  toolUse: NormalizedToolUse,
): readonly string[] {
  const groups = toolUsePatchGroups(toolUse);
  if (!groups) return [];
  return groups.flatMap((group) => [
    `${OUTPUT_CORNER} ${group.fileLabel}`,
    ...diffDisplayLines(group.hunks, MAX_PATCH_LINES).map(
      (line) => `  ${line.text}`,
    ),
  ]);
}

function formatHeader(
  toolUse: NormalizedToolUse,
  displayName = displayToolName(toolUse.toolName) || 'tool',
): string {
  const sourceText = toolUse.headerSummary || previewInput(toolUse.input) || '';
  const preview = sourceText
    ? truncateWithEllipsis(collapseWhitespace(sourceText), MAX_HEADER_PREVIEW)
    : '';
  return `${STATUS_DOT} ${displayName}${preview ? ` (${preview})` : ''}`;
}

function visibleOutputLines(toolUse: NormalizedToolUse): {
  readonly lines: readonly string[];
  readonly hiddenCount: number;
} {
  const lines = toolUse.outputText ? toolUse.outputText.split('\n') : [];
  const visible = lines.slice(0, MAX_OUTPUT_LINES);
  return {
    lines: visible,
    hiddenCount: Math.max(0, lines.length - visible.length),
  };
}

function extractExitCode(toolUse: NormalizedToolUse): number | undefined {
  const candidates = [toolUse.parsed, toolUse.input];
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;
    const raw =
      candidate.exitCode ??
      candidate.exit_code ??
      (isPlainObject(candidate.output) ? candidate.output.exitCode : undefined);
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  }

  const match = /\bexit(?: code)?\s+(\d+)\b/i.exec(
    [toolUse.errorText, toolUse.headerSummary, toolUse.outputText].join('\n'),
  );
  return match ? Number(match[1]) : undefined;
}

function outputDisplayLines(toolUse: NormalizedToolUse): string[] {
  const { lines, hiddenCount } = visibleOutputLines(toolUse);
  return [
    ...lines.map((line, index) =>
      index === 0 ? `${OUTPUT_CORNER} ${line}` : `  ${line}`,
    ),
    ...(hiddenCount > 0
      ? [`  … +${hiddenCount} line${hiddenCount === 1 ? '' : 's'}`]
      : []),
  ];
}

export function universalToolUseDisplayLines(
  toolUse: NormalizedToolUse,
  options: { readonly displayName?: string } = {},
): readonly string[] {
  const patchLines = toolUsePatchDisplayLines(toolUse);
  const errorText = toolUse.isError ? toolUse.errorText || '(error)' : '';
  const outputLines = outputDisplayLines(toolUse);
  const showNoOutput =
    toolUse.status === TOOL_USE_STATUS.COMPLETED &&
    outputLines.length === 0 &&
    patchLines.length === 0 &&
    !toolUse.isError;

  return [
    formatHeader(toolUse, options.displayName),
    ...outputLines,
    ...patchLines,
    ...(toolUse.isError
      ? [
          `${OUTPUT_CORNER} ${truncateWithEllipsis(
            collapseWhitespace(errorText),
            MAX_ERROR_PREVIEW,
          )}`,
        ]
      : []),
    ...(showNoOutput ? [`${OUTPUT_CORNER} (no output)`] : []),
  ];
}

export function bashToolUseDisplayLines(
  toolUse: NormalizedToolUse,
): readonly string[] {
  const exitCode = extractExitCode(toolUse);
  const outputLines = outputDisplayLines(toolUse);
  const errorText = toolUse.isError ? toolUse.errorText || '(error)' : '';
  return [
    formatHeader(toolUse),
    ...outputLines,
    ...(toolUse.isError && exitCode !== undefined
      ? [`${OUTPUT_CORNER} exit ${exitCode}`]
      : []),
    ...(toolUse.isError
      ? [
          `${OUTPUT_CORNER} ${truncateWithEllipsis(
            collapseWhitespace(errorText),
            MAX_ERROR_PREVIEW,
          )}`,
        ]
      : []),
    ...(toolUse.status === TOOL_USE_STATUS.COMPLETED &&
    !toolUse.isError &&
    outputLines.length === 0
      ? [`${OUTPUT_CORNER} (no output)`]
      : []),
  ];
}

function PatchPreview({
  groups,
}: {
  readonly groups: readonly InlinePatchGroup[];
}): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {groups.map((group, index) => (
        <Box key={`${group.fileLabel}-${index}`} flexDirection="column">
          <Text dimColor>{`${OUTPUT_CORNER} ${group.fileLabel}`}</Text>
          <Box flexDirection="column" paddingLeft={2}>
            <DiffView hunks={group.hunks} maxHunkLines={MAX_PATCH_LINES} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function UniversalToolRow({
  toolUse,
  displayName,
}: {
  readonly toolUse: NormalizedToolUse;
  readonly displayName?: string;
}): React.JSX.Element {
  const color = statusColor(toolUse);
  const name = (displayName ?? displayToolName(toolUse.toolName)) || 'tool';

  const { patchGroups, preview, visibleOutput, hiddenCount } = useMemo(() => {
    const sourceText =
      toolUse.headerSummary || previewInput(toolUse.input) || '';
    const previewText = sourceText
      ? truncateWithEllipsis(collapseWhitespace(sourceText), MAX_HEADER_PREVIEW)
      : '';
    const { lines, hiddenCount: hidden } = visibleOutputLines(toolUse);
    return {
      patchGroups: toolUsePatchGroups(toolUse),
      preview: previewText,
      visibleOutput: lines,
      hiddenCount: hidden,
    };
  }, [toolUse]);

  const errorText = toolUse.isError ? toolUse.errorText || '(error)' : '';
  const showError = toolUse.isError;
  const showNoOutput =
    toolUse.status === TOOL_USE_STATUS.COMPLETED &&
    visibleOutput.length === 0 &&
    !patchGroups &&
    !showError;

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
      {patchGroups ? <PatchPreview groups={patchGroups} /> : null}
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

function BashToolRow({
  toolUse,
}: {
  readonly toolUse: NormalizedToolUse;
}): React.JSX.Element {
  const color = statusColor(toolUse);
  const exitCode = extractExitCode(toolUse);
  const { lines: visibleOutput, hiddenCount } = visibleOutputLines(toolUse);
  const preview = previewInput(toolUse.input) || toolUse.headerSummary;
  const previewText = preview
    ? truncateWithEllipsis(collapseWhitespace(preview), MAX_HEADER_PREVIEW)
    : '';
  const errorText = toolUse.isError ? toolUse.errorText || '(error)' : '';
  const showNoOutput =
    toolUse.status === TOOL_USE_STATUS.COMPLETED &&
    visibleOutput.length === 0 &&
    !toolUse.isError;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" flexWrap="nowrap">
        <Text color={color} dimColor={!color}>
          {STATUS_DOT}{' '}
        </Text>
        <Text bold>{displayToolName(toolUse.toolName) || 'bash'}</Text>
        {previewText ? <Text color="cyan">{` (${previewText})`}</Text> : null}
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
      {toolUse.isError && exitCode !== undefined ? (
        <Box flexDirection="row" flexWrap="nowrap" paddingLeft={2}>
          <Text dimColor>{`${OUTPUT_CORNER} `}</Text>
          <Text color="red">{`exit ${exitCode}`}</Text>
        </Box>
      ) : null}
      {toolUse.isError ? (
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

function isBashTool(toolUse: NormalizedToolUse): boolean {
  return lastSegmentToolName(toolUse.toolName).toLowerCase() === 'bash';
}

function isMcpTool(toolUse: NormalizedToolUse): boolean {
  return displayMcpToolName(toolUse.toolName) !== undefined;
}

const editRenderer: ToolRenderer = {
  key: 'edit',
  matches: (toolUse) => toolUsePatchGroups(toolUse) !== undefined,
  render: (toolUse) => <UniversalToolRow toolUse={toolUse} />,
  displayLines: (toolUse) => universalToolUseDisplayLines(toolUse),
};

const bashRenderer: ToolRenderer = {
  key: 'bash',
  matches: isBashTool,
  render: (toolUse) => <BashToolRow toolUse={toolUse} />,
  displayLines: bashToolUseDisplayLines,
};

const mcpRenderer: ToolRenderer = {
  key: 'mcp',
  matches: isMcpTool,
  render: (toolUse) => (
    <UniversalToolRow
      toolUse={toolUse}
      displayName={displayMcpToolName(toolUse.toolName)}
    />
  ),
  displayLines: (toolUse) =>
    universalToolUseDisplayLines(toolUse, {
      displayName: displayMcpToolName(toolUse.toolName),
    }),
};

const REGISTRY: readonly ToolRenderer[] = [
  editRenderer,
  bashRenderer,
  mcpRenderer,
];

export function pickToolRenderer(
  toolUse: NormalizedToolUse,
): ToolRenderer | undefined {
  return REGISTRY.find((renderer) => renderer.matches(toolUse));
}

export function toolUseDisplayLines(
  toolUse: NormalizedToolUse,
): readonly string[] {
  return (
    pickToolRenderer(toolUse)?.displayLines(toolUse) ??
    universalToolUseDisplayLines(toolUse)
  );
}
