// Third-party imports
import { useMemo } from 'react';

import { Box, Text, useWindowSize } from 'ink';

// Local imports - shared schemas and utilities
import { TOOL_USE_STATUS, type NormalizedToolUse } from '@shared/schemas';
import { toolDisplayKind } from '@shared/tools/toolKind';
import { isObject } from '@utils/core';
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
import {
  textDisplayWidth,
  truncateSummaryToWidth,
} from '../render/terminalText';
import { COLOR_ERROR, COLOR_HINT, COLOR_SUCCESS } from '../ui/colors';
import { STATUS_DOT, TOOL_OUTPUT_CORNER } from '../ui/glyphs';
const MAX_HEADER_PREVIEW = 80;
const MAX_ERROR_PREVIEW = 240;
// Header chrome around the preview: `● ` plus ` (` and `)`.
const HEADER_CHROME_COLS = 5;
// Below this many remaining columns, drop the preview instead of overflowing
// the row.
const MIN_HEADER_PREVIEW = 4;

/** Preview budget (in display columns) for live tool rows: fill the terminal
 *  row instead of the historical fixed 80 columns, so wide terminals show the
 *  whole command and narrow ones truncate to fit a single row. Returns 0 (no
 *  preview) when the tool name plus chrome already eat the row. */
export function toolHeaderPreviewBudget(
  columns: number | undefined,
  displayName: string,
): number {
  if (columns === undefined || columns <= 0) return MAX_HEADER_PREVIEW;
  const available =
    columns - textDisplayWidth(displayName) - HEADER_CHROME_COLS;
  return available >= MIN_HEADER_PREVIEW ? available : 0;
}

// Tool output can be arbitrarily large (a 50 KB bash dump, a long grep). The
// finalized `<Static>` scrollback and the live region show a head+tail slice
// with a `… +N lines` marker; the full text stays on `toolUse.outputText` and
// is reachable via the ctrl+t transcript viewer. Tune head/tail here.
const OUTPUT_HEAD_LINES = 6;
const OUTPUT_TAIL_LINES = 3;
const OUTPUT_MARKER_LINES = 1;

interface ElidedOutput {
  readonly head: readonly string[];
  readonly tail: readonly string[];
  readonly hiddenCount: number;
}

function elideOutputLines(lines: readonly string[]): ElidedOutput {
  // Only elide when the head + marker + tail form is shorter than the original.
  if (
    lines.length <=
    OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES + OUTPUT_MARKER_LINES
  ) {
    return { head: lines, tail: [], hiddenCount: 0 };
  }
  return {
    head: lines.slice(0, OUTPUT_HEAD_LINES),
    tail: lines.slice(lines.length - OUTPUT_TAIL_LINES),
    hiddenCount: lines.length - OUTPUT_HEAD_LINES - OUTPUT_TAIL_LINES,
  };
}

function elisionMarker(hiddenCount: number): string {
  return `… +${hiddenCount} lines (ctrl + t to view transcript)`;
}

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

export interface DisplayLineOptions {
  /** When false, emit the full output instead of the head+tail slice.
   *  The transcript viewer (ctrl+t) sets this to show everything. */
  readonly elide?: boolean;
}

export interface ToolRenderer {
  readonly key: string;
  matches(toolUse: NormalizedToolUse): boolean;
  render(toolUse: NormalizedToolUse): React.JSX.Element;
  /** Text geometry for budgeting and plain projections. Keep one line for
   *  every visually distinct row emitted by `render`. */
  displayLines(
    toolUse: NormalizedToolUse,
    options?: DisplayLineOptions,
  ): readonly string[];
}

function lastSegmentToolName(toolName: string): string {
  // Drop provider/handler prefixes like `claude:Bash` so non-MCP tools
  // keep the historical compact label.
  const lastColon = toolName.lastIndexOf(':');
  return lastColon >= 0 ? toolName.slice(lastColon + 1) : toolName;
}

function displayMcpToolName(toolName: string): string | undefined {
  const parts = toolName.split(':').filter(Boolean);
  if (parts.length < 3 || parts[0].toLowerCase() !== 'mcp') {
    return undefined;
  }
  return `${parts[1]}/${parts.slice(2).join(':')}`;
}

function displayToolName(toolName: string): string {
  return displayMcpToolName(toolName) ?? lastSegmentToolName(toolName);
}

function previewInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === undefined || input === null) return '';
  if (isObject(input)) {
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

function statusColor(
  toolUse: NormalizedToolUse,
): typeof COLOR_SUCCESS | typeof COLOR_ERROR | undefined {
  if (toolUse.isError) return COLOR_ERROR;
  if (toolUse.status === TOOL_USE_STATUS.COMPLETED) return COLOR_SUCCESS;
  return undefined;
}

function isEditLikeTool(toolName: string): boolean {
  const name = lastSegmentToolName(toolName).toLowerCase();
  if (toolDisplayKind(name) === 'edit') return true;
  // Beyond TeXRA's own tool registry: a delegated Claude Code sub-agent
  // reports its own built-in tool names (`edit`, `multiedit`) verbatim, and
  // some provider tool-use variants carry a `str_replace`/`text_editor`
  // substring instead of one of the exact names classified above.
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
  // Plain text only: the colored full-width bands come from the `DiffView`
  // component (live cards + scrollback render through it); these lines feed the
  // transcript viewer and stay uncolored.
  return groups.flatMap((group) => [
    `${TOOL_OUTPUT_CORNER} ${group.fileLabel}`,
    ...diffDisplayLines(group.hunks).map((line) => `  ${line.text}`),
  ]);
}

/** One-line input/summary preview for a tool header, truncated to
 *  `maxPreview` display columns (so wide glyphs cannot overflow the budget).
 *  Bash rows prefer the command text (input) over the generic header summary;
 *  all other tools prefer the curated per-tool summary first. */
function toolHeaderPreview(
  toolUse: NormalizedToolUse,
  maxPreview = MAX_HEADER_PREVIEW,
  preferInputPreview = false,
): string {
  if (maxPreview <= 0) return '';
  const sourceText = preferInputPreview
    ? previewInput(toolUse.input) || toolUse.headerSummary || ''
    : toolUse.headerSummary || previewInput(toolUse.input) || '';
  return sourceText ? truncateSummaryToWidth(sourceText, maxPreview) : '';
}

function formatHeader(
  toolUse: NormalizedToolUse,
  displayName = displayToolName(toolUse.toolName) || 'tool',
): string {
  const preview = toolHeaderPreview(toolUse);
  return `${STATUS_DOT} ${displayName}${preview ? ` (${preview})` : ''}`;
}

function errorTextForDisplay(toolUse: NormalizedToolUse): string {
  return toolUse.isError ? toolUse.errorText || '(error)' : '';
}

/** Single corner line with the collapsed, truncated error text, or none when
 *  the tool did not error. */
function errorCornerLines(toolUse: NormalizedToolUse): readonly string[] {
  const errorText = errorTextForDisplay(toolUse);
  if (!errorText) return [];
  return [
    `${TOOL_OUTPUT_CORNER} ${truncateWithEllipsis(
      collapseWhitespace(errorText),
      MAX_ERROR_PREVIEW,
    )}`,
  ];
}

function errorPreviewWouldTruncate(toolUse: NormalizedToolUse): boolean {
  return (
    collapseWhitespace(errorTextForDisplay(toolUse)).length > MAX_ERROR_PREVIEW
  );
}

function outputDuplicatesError(
  toolUse: NormalizedToolUse,
  options: { readonly keepWhenErrorPreviewTruncates?: boolean } = {},
): boolean {
  if (!toolUse.isError || !toolUse.outputText) return false;
  const errorText = errorTextForDisplay(toolUse);
  if (
    options.keepWhenErrorPreviewTruncates &&
    errorPreviewWouldTruncate(toolUse)
  ) {
    return false;
  }
  return (
    errorText.length > 0 &&
    collapseWhitespace(toolUse.outputText) === collapseWhitespace(errorText)
  );
}

function visibleOutputLines(
  toolUse: NormalizedToolUse,
  options: { readonly keepDuplicateWhenErrorPreviewTruncates?: boolean } = {},
): readonly string[] {
  if (
    outputDuplicatesError(toolUse, {
      keepWhenErrorPreviewTruncates:
        options.keepDuplicateWhenErrorPreviewTruncates,
    })
  ) {
    return [];
  }
  return toolUse.outputText ? toolUse.outputText.split('\n') : [];
}

function extractExitCode(toolUse: NormalizedToolUse): number | undefined {
  const candidates = [toolUse.parsed, toolUse.input];
  for (const candidate of candidates) {
    if (!isObject(candidate)) continue;
    const raw =
      candidate.exitCode ??
      candidate.exit_code ??
      (isObject(candidate.output) ? candidate.output.exitCode : undefined);
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  }

  const match = /\bexit(?: code)?\s+(\d+)\b/i.exec(
    [toolUse.errorText, toolUse.headerSummary, toolUse.outputText].join('\n'),
  );
  return match ? Number(match[1]) : undefined;
}

function outputDisplayLines(
  toolUse: NormalizedToolUse,
  elide = true,
): string[] {
  const lines = visibleOutputLines(toolUse, {
    keepDuplicateWhenErrorPreviewTruncates: !elide,
  });
  const sliced = elide
    ? elideOutputLines(lines)
    : { head: lines, tail: [] as readonly string[], hiddenCount: 0 };
  const out = sliced.head.map((line, index) =>
    index === 0 ? `${TOOL_OUTPUT_CORNER} ${line}` : `  ${line}`,
  );
  if (sliced.hiddenCount > 0) {
    out.push(`  ${elisionMarker(sliced.hiddenCount)}`);
  }
  for (const line of sliced.tail) out.push(`  ${line}`);
  return out;
}

function universalToolUseDisplayLines(
  toolUse: NormalizedToolUse,
  options: {
    readonly displayName?: string;
    readonly showOutput?: boolean;
    readonly elide?: boolean;
  } = {},
): readonly string[] {
  const patchLines = toolUsePatchDisplayLines(toolUse);
  const outputLines =
    options.showOutput === true
      ? outputDisplayLines(toolUse, options.elide ?? true)
      : [];
  const showNoOutput =
    options.showOutput === true &&
    toolUse.status === TOOL_USE_STATUS.COMPLETED &&
    outputLines.length === 0 &&
    patchLines.length === 0 &&
    !toolUse.isError;

  return [
    formatHeader(toolUse, options.displayName),
    ...outputLines,
    ...patchLines,
    ...errorCornerLines(toolUse),
    ...(showNoOutput ? [`${TOOL_OUTPUT_CORNER} (no output)`] : []),
  ];
}

function bashToolUseDisplayLines(
  toolUse: NormalizedToolUse,
  options: { readonly elide?: boolean } = {},
): readonly string[] {
  const exitCode = extractExitCode(toolUse);
  const outputLines = outputDisplayLines(toolUse, options.elide ?? true);
  return [
    formatHeader(toolUse),
    ...outputLines,
    ...(toolUse.isError && exitCode !== undefined
      ? [`${TOOL_OUTPUT_CORNER} exit ${exitCode}`]
      : []),
    ...errorCornerLines(toolUse),
    ...(toolUse.status === TOOL_USE_STATUS.COMPLETED &&
    !toolUse.isError &&
    outputLines.length === 0
      ? [`${TOOL_OUTPUT_CORNER} (no output)`]
      : []),
  ];
}

/** Combined left padding of the two nested boxes wrapping the patch diff. */
const PATCH_PREVIEW_INDENT = 4;

function PatchPreview({
  groups,
}: {
  readonly groups: readonly InlinePatchGroup[];
}): React.JSX.Element {
  // The diff sits under two nested `paddingLeft={2}` boxes; derive its width
  // from the real terminal so the full-row bands fill exactly the available
  // columns instead of padding to a fixed default and wrapping on narrow
  // terminals. `DiffView` floors this at its own minimum.
  const { columns } = useWindowSize();
  const diffWidth = columns - PATCH_PREVIEW_INDENT;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {groups.map((group, index) => (
        <Box key={`${group.fileLabel}-${index}`} flexDirection="column">
          <Text dimColor>{`${TOOL_OUTPUT_CORNER} ${group.fileLabel}`}</Text>
          <Box flexDirection="column" paddingLeft={2}>
            <DiffView hunks={group.hunks} width={diffWidth} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function OutputBlock({
  lines,
}: {
  readonly lines: readonly string[];
}): React.JSX.Element | null {
  if (lines.length === 0) return null;
  const { head, tail, hiddenCount } = elideOutputLines(lines);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {head.map((line, index) => (
        <Box key={`h${index}`} flexDirection="row" flexWrap="nowrap">
          <Text dimColor>{index === 0 ? `${TOOL_OUTPUT_CORNER} ` : '  '}</Text>
          <Text>{line}</Text>
        </Box>
      ))}
      {hiddenCount > 0 && (
        <Box flexDirection="row" flexWrap="nowrap">
          <Text dimColor>{'  '}</Text>
          <Text dimColor>{elisionMarker(hiddenCount)}</Text>
        </Box>
      )}
      {tail.map((line, index) => (
        <Box key={`t${index}`} flexDirection="row" flexWrap="nowrap">
          <Text dimColor>{'  '}</Text>
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

function CornerLine({
  color,
  children,
}: {
  readonly color?: typeof COLOR_ERROR;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" flexWrap="nowrap" paddingLeft={2}>
      <Text dimColor>{`${TOOL_OUTPUT_CORNER} `}</Text>
      <Text color={color} dimColor={!color}>
        {children}
      </Text>
    </Box>
  );
}

interface ToolRowProps {
  readonly toolUse: NormalizedToolUse;
  readonly displayName?: string;
  readonly fallbackName?: string;
  readonly previewColor?: typeof COLOR_HINT;
  readonly showPatch?: boolean;
  readonly showOutput?: boolean;
  readonly showExitCode?: boolean;
  readonly preferInputPreview?: boolean;
}

function ToolRow(props: ToolRowProps): React.JSX.Element {
  const {
    toolUse,
    previewColor,
    showPatch = false,
    showOutput = false,
    showExitCode = false,
    preferInputPreview = false,
  } = props;
  const { columns } = useWindowSize();
  const color = statusColor(toolUse);
  const name =
    (props.displayName ?? displayToolName(toolUse.toolName)) ||
    props.fallbackName ||
    'tool';

  const { patchGroups, preview, visibleOutput } = useMemo(
    () => ({
      patchGroups: showPatch ? toolUsePatchGroups(toolUse) : undefined,
      preview: toolHeaderPreview(
        toolUse,
        toolHeaderPreviewBudget(columns, name),
        preferInputPreview,
      ),
      visibleOutput: showOutput ? visibleOutputLines(toolUse) : [],
    }),
    [toolUse, showPatch, showOutput, preferInputPreview, columns, name],
  );

  const errorText = errorTextForDisplay(toolUse);
  const exitCode = showExitCode ? extractExitCode(toolUse) : undefined;
  const showNoOutput =
    showOutput &&
    toolUse.status === TOOL_USE_STATUS.COMPLETED &&
    visibleOutput.length === 0 &&
    !patchGroups &&
    !toolUse.isError;

  return (
    <Box flexDirection="column" marginBottom={toolUseMarginBottomRows(toolUse)}>
      <Box flexDirection="row" flexWrap="nowrap">
        <Text color={color} dimColor={!color}>
          {STATUS_DOT}{' '}
        </Text>
        <Text bold>{name}</Text>
        {preview ? (
          <Text color={previewColor} dimColor={!previewColor}>
            {` (${preview})`}
          </Text>
        ) : null}
      </Box>
      <OutputBlock lines={visibleOutput} />
      {patchGroups ? <PatchPreview groups={patchGroups} /> : null}
      {toolUse.isError && exitCode !== undefined ? (
        <CornerLine color={COLOR_ERROR}>{`exit ${exitCode}`}</CornerLine>
      ) : null}
      {toolUse.isError ? (
        <CornerLine color={COLOR_ERROR}>
          {truncateWithEllipsis(
            collapseWhitespace(errorText),
            MAX_ERROR_PREVIEW,
          )}
        </CornerLine>
      ) : null}
      {showNoOutput ? <CornerLine>(no output)</CornerLine> : null}
    </Box>
  );
}

export function UniversalToolRow({
  toolUse,
  displayName,
  showOutput,
}: {
  readonly toolUse: NormalizedToolUse;
  readonly displayName?: string;
  readonly showOutput?: boolean;
}): React.JSX.Element {
  return (
    <ToolRow
      toolUse={toolUse}
      displayName={displayName}
      showPatch={true}
      showOutput={showOutput}
    />
  );
}

function isBashTool(toolUse: NormalizedToolUse): boolean {
  return (
    toolDisplayKind(lastSegmentToolName(toolUse.toolName).toLowerCase()) ===
    'bash'
  );
}

function isMcpTool(toolUse: NormalizedToolUse): boolean {
  return displayMcpToolName(toolUse.toolName) !== undefined;
}

const editRenderer: ToolRenderer = {
  key: 'edit',
  matches: (toolUse) => toolUsePatchGroups(toolUse) !== undefined,
  render: (toolUse) => <UniversalToolRow toolUse={toolUse} />,
  displayLines: (toolUse, options) =>
    universalToolUseDisplayLines(toolUse, { elide: options?.elide }),
};

const bashRenderer: ToolRenderer = {
  key: 'bash',
  matches: isBashTool,
  render: (toolUse) => (
    <ToolRow
      toolUse={toolUse}
      fallbackName="bash"
      previewColor={COLOR_HINT}
      showOutput={true}
      showExitCode={true}
      preferInputPreview={true}
    />
  ),
  displayLines: (toolUse, options) =>
    bashToolUseDisplayLines(toolUse, { elide: options?.elide }),
};

const mcpRenderer: ToolRenderer = {
  key: 'mcp',
  matches: isMcpTool,
  render: (toolUse) => (
    <UniversalToolRow
      toolUse={toolUse}
      displayName={displayMcpToolName(toolUse.toolName)}
      showOutput={true}
    />
  ),
  displayLines: (toolUse, options) =>
    universalToolUseDisplayLines(toolUse, {
      displayName: displayMcpToolName(toolUse.toolName),
      showOutput: true,
      elide: options?.elide,
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

// Memoized per NormalizedToolUse object. `subscribeStreamLog` keeps the
// toolUse reference stable across sync ticks unless its content changed, so
// the derived lines (including diff hunks for edit tools) can be shared by
// the live row estimator, the bounded renderer, and static row counting
// instead of being recomputed for every visible tool row on every frame.
interface ToolUseDisplayLinesCacheEntry {
  elided?: readonly string[];
  full?: readonly string[];
}
const displayLinesCache = new WeakMap<
  NormalizedToolUse,
  ToolUseDisplayLinesCacheEntry
>();

export function toolUseDisplayLines(
  toolUse: NormalizedToolUse,
  options?: DisplayLineOptions,
): readonly string[] {
  const slot = options?.elide === false ? 'full' : 'elided';
  let cached = displayLinesCache.get(toolUse);
  const hit = cached?.[slot];
  if (hit) return hit;
  const lines =
    pickToolRenderer(toolUse)?.displayLines(toolUse, options) ??
    universalToolUseDisplayLines(toolUse, { elide: options?.elide });
  if (!cached) {
    cached = {};
    displayLinesCache.set(toolUse, cached);
  }
  cached[slot] = lines;
  return lines;
}

/** Tool detail rows are separated from the next conversation entry. Derive
 *  that geometry from the same display-line model used by row budgeting. */
export function toolUseMarginBottomRows(toolUse: NormalizedToolUse): 0 | 1 {
  return toolUseDisplayLines(toolUse).length > 1 ? 1 : 0;
}
