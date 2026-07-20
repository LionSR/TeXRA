// Tool-row rendering: one styled-line model is the single source of truth.
//
// `toolUseStyledLines` builds every visually distinct row of a tool card as
// spans (text + color/dim/bold); the Ink painter in ToolUseRow renders those
// spans, and `toolUseDisplayLines` projects the same lines to plain text for
// the row-budget estimator, static row counting, and ctrl+t full-output
// printing. The two presentations can no longer drift because there is nothing
// to keep in sync by hand — the patch preview (DiffView) is the one rich
// block that renders beyond its plain-text projection.

// Local imports - shared schemas and utilities
import { TOOL_USE_STATUS, type NormalizedToolUse } from '@shared/schemas';
import {
  executionsSubagentSummary,
  type ExecutionLabels,
} from '@shared/tools/executionsDisplay';
import { toolDisplayKind } from '@shared/tools/toolKind';
import { isObject } from '@utils/core';
import {
  collapseWhitespace,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';

// Local imports - CLI TUI rendering
import {
  diffDisplayLines,
  editPatchGroups,
  type InlinePatchGroup,
  wrappedDiffDisplayLines,
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
// can be printed into terminal scrollback with ctrl+t. Tune head/tail here.
const OUTPUT_HEAD_LINES = 6;
const OUTPUT_TAIL_LINES = 3;
const OUTPUT_MARKER_LINES = 1;
// The head/tail budget above only bounds line *count*. A tool's stdout can
// also be a single, arbitrarily long "line" with no newlines to elide
// against (e.g. a `rg` match inside a minified bundle) — cap each line's
// rendered width too, so one pathological line can't blow past the budget
// it was supposed to be bounded by.
const OUTPUT_LINE_MAX_CHARS = 2000;

interface ElidedOutput {
  readonly head: readonly string[];
  readonly tail: readonly string[];
  readonly hiddenCount: number;
}

function capLine(line: string): string {
  return truncateWithEllipsis(line, OUTPUT_LINE_MAX_CHARS);
}

function elideOutputLines(lines: readonly string[]): ElidedOutput {
  // Only elide when the head + marker + tail form is shorter than the original.
  if (
    lines.length <=
    OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES + OUTPUT_MARKER_LINES
  ) {
    return { head: lines.map(capLine), tail: [], hiddenCount: 0 };
  }
  // Cap only the head/tail lines actually rendered, not every discarded line
  // in between — this runs while a tool streams, so truncating lines nobody
  // sees would be wasted grapheme-segmentation work.
  return {
    head: lines.slice(0, OUTPUT_HEAD_LINES).map(capLine),
    tail: lines.slice(lines.length - OUTPUT_TAIL_LINES).map(capLine),
    hiddenCount: lines.length - OUTPUT_HEAD_LINES - OUTPUT_TAIL_LINES,
  };
}

function elisionMarker(hiddenCount: number): string {
  return `… +${hiddenCount} lines (ctrl + t to print full output)`;
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
   *  The ctrl+t print path sets this to include everything. */
  readonly elide?: boolean;
  /** Include raw output for a caller with an explicit result surface. */
  readonly showOutput?: boolean;
  /** Render the status marker without active or terminal state color. */
  readonly neutralStatus?: boolean;
  /** Terminal columns when the projection must match rich rendered rows. */
  readonly width?: number;
  /** Retained subagent identities used by executions wait/view headers. */
  readonly executionLabels?: ExecutionLabels;
}

/** One styled fragment of a tool row. */
interface ToolDisplaySpan {
  readonly text: string;
  readonly bold?: boolean;
  readonly color?: string;
  readonly dim?: boolean;
}

/** A tool card row: ordinary span rows, plus one rich patch block whose
 *  plain-text projection is carried alongside its DiffView groups. */
export type ToolDisplayLine =
  | { readonly kind: 'row'; readonly spans: readonly ToolDisplaySpan[] }
  | {
      readonly kind: 'patch';
      readonly groups: readonly InlinePatchGroup[];
      readonly textLines: readonly string[];
    };

function row(spans: readonly ToolDisplaySpan[]): ToolDisplayLine {
  return Object.freeze({
    kind: 'row',
    spans: Object.freeze(spans.map((span) => Object.freeze(span))),
  });
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

function patchTextLines(
  groups: readonly InlinePatchGroup[],
  width?: number,
): string[] {
  // Plain text only: the colored full-width bands come from the `DiffView`
  // component; these lines feed row budgeting and full-output printing.
  const diffWidth = width === undefined ? undefined : width - 4;
  return groups.flatMap((group) => [
    `${TOOL_OUTPUT_CORNER} ${group.fileLabel}`,
    ...(diffWidth === undefined
      ? diffDisplayLines(group.hunks)
      : wrappedDiffDisplayLines(group.hunks, diffWidth)
    ).map((line) => `  ${line.text}`),
  ]);
}

/** One-line input/summary preview for a tool header, truncated to
 *  `maxPreview` display columns (so wide glyphs cannot overflow the budget).
 *  Bash rows prefer the command text (input) over the generic header summary;
 *  all other tools prefer the curated per-tool summary first. */
function toolHeaderPreview(
  toolUse: NormalizedToolUse,
  maxPreview: number,
  preferInputPreview: boolean,
  summaryOverride?: string,
): string {
  if (maxPreview <= 0) return '';
  const headerSummary = summaryOverride ?? toolUse.headerSummary;
  const sourceText = preferInputPreview
    ? previewInput(toolUse.input) || headerSummary || ''
    : headerSummary || previewInput(toolUse.input) || '';
  return sourceText ? truncateSummaryToWidth(sourceText, maxPreview) : '';
}

function errorTextForDisplay(toolUse: NormalizedToolUse): string {
  return toolUse.isError ? toolUse.errorText || '(error)' : '';
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
  elide: boolean,
): readonly string[] {
  if (
    outputDuplicatesError(toolUse, {
      keepWhenErrorPreviewTruncates: !elide,
    })
  ) {
    return [];
  }
  return toolUse.outputText ? toolUse.outputText.split('\n') : [];
}

function extractExitCode(toolUse: NormalizedToolUse): number | undefined {
  if (toolUse.exitCode !== undefined) return toolUse.exitCode;

  const match = /\bexit(?: code)?\s+(\d+)\b/i.exec(
    [toolUse.errorText, toolUse.headerSummary, toolUse.outputText].join('\n'),
  );
  return match ? Number(match[1]) : undefined;
}

const CORNER_PREFIX_SPAN: ToolDisplaySpan = Object.freeze({
  text: `${TOOL_OUTPUT_CORNER} `,
  dim: true,
});
const CONTINUATION_PREFIX_SPAN: ToolDisplaySpan = Object.freeze({
  text: '  ',
  dim: true,
});

function outputRows(
  toolUse: NormalizedToolUse,
  elide: boolean,
): ToolDisplayLine[] {
  const lines = visibleOutputLines(toolUse, elide);
  const sliced = elide
    ? elideOutputLines(lines)
    : { head: lines, tail: [] as readonly string[], hiddenCount: 0 };
  const rows = sliced.head.map((line, index) =>
    row([
      index === 0 ? CORNER_PREFIX_SPAN : CONTINUATION_PREFIX_SPAN,
      { text: line },
    ]),
  );
  if (sliced.hiddenCount > 0) {
    rows.push(
      row([
        CONTINUATION_PREFIX_SPAN,
        { text: elisionMarker(sliced.hiddenCount), dim: true },
      ]),
    );
  }
  for (const line of sliced.tail) {
    rows.push(row([CONTINUATION_PREFIX_SPAN, { text: line }]));
  }
  return rows;
}

/** Per-kind presentation switches — the whole replacement for the old
 *  matches/render/displayLines renderer registry, in the registry's
 *  precedence order: edit-style (a parseable patch) wins over MCP and bash. */
function toolRowOptions(
  toolUse: NormalizedToolUse,
  hasPatch: boolean,
): {
  readonly displayName: string;
  readonly preferInputPreview: boolean;
  readonly previewColor: string | undefined;
  readonly showExitCode: boolean;
  readonly showOutput: boolean;
} {
  const plain = {
    displayName: displayToolName(toolUse.toolName) || 'tool',
    preferInputPreview: false,
    previewColor: undefined,
    showExitCode: false,
    showOutput: false,
  };
  // Edit-like tools show their patch preview instead of raw output.
  if (hasPatch) return plain;
  const isBash =
    toolDisplayKind(lastSegmentToolName(toolUse.toolName).toLowerCase()) ===
    'bash';
  if (isBash) {
    return {
      displayName: displayToolName(toolUse.toolName) || 'bash',
      preferInputPreview: true,
      previewColor: COLOR_HINT,
      showExitCode: true,
      showOutput: true,
    };
  }
  if (displayMcpToolName(toolUse.toolName) !== undefined) {
    return { ...plain, showOutput: true };
  }
  // Every other tool keeps the compact header-only row (plus error and
  // no-output corners) so e.g. a read_file result never dumps file contents.
  return plain;
}

function buildStyledLines(
  toolUse: NormalizedToolUse,
  options: DisplayLineOptions,
  executionSummary: string | undefined,
): readonly ToolDisplayLine[] {
  const elide = options.elide !== false;
  const patchGroups = toolUsePatchGroups(toolUse);
  const opts = toolRowOptions(toolUse, patchGroups !== undefined);
  const color =
    options.neutralStatus === true ? undefined : statusColor(toolUse);
  const preview = toolHeaderPreview(
    toolUse,
    options.width === undefined
      ? MAX_HEADER_PREVIEW
      : toolHeaderPreviewBudget(options.width, opts.displayName),
    opts.preferInputPreview,
    executionSummary,
  );

  const showOutput = options.showOutput === true || opts.showOutput;
  const output = showOutput ? outputRows(toolUse, elide) : [];
  const exitCode =
    opts.showExitCode && toolUse.isError ? extractExitCode(toolUse) : undefined;
  const errorText = errorTextForDisplay(toolUse);
  const showNoOutput =
    showOutput &&
    toolUse.status === TOOL_USE_STATUS.COMPLETED &&
    output.length === 0 &&
    !patchGroups &&
    !toolUse.isError;

  return [
    row([
      { text: `${STATUS_DOT} `, color, dim: !color },
      { text: opts.displayName, bold: true },
      ...(preview
        ? [
            {
              text: ` (${preview})`,
              color: opts.previewColor,
              dim: !opts.previewColor,
            },
          ]
        : []),
    ]),
    ...output,
    ...(patchGroups
      ? [
          {
            kind: 'patch' as const,
            groups: patchGroups,
            textLines: patchTextLines(patchGroups, options.width),
          },
        ]
      : []),
    ...(exitCode !== undefined
      ? [
          row([
            CORNER_PREFIX_SPAN,
            { text: `exit ${exitCode}`, color: COLOR_ERROR },
          ]),
        ]
      : []),
    ...(errorText
      ? [
          row([
            CORNER_PREFIX_SPAN,
            {
              text: truncateWithEllipsis(
                collapseWhitespace(errorText),
                MAX_ERROR_PREVIEW,
              ),
              color: COLOR_ERROR,
            },
          ]),
        ]
      : []),
    ...(showNoOutput
      ? [row([CORNER_PREFIX_SPAN, { text: '(no output)', dim: true }])]
      : []),
  ];
}

// Memoized per NormalizedToolUse object. `subscribeStreamLog` keeps the
// toolUse reference stable across sync ticks unless its content changed, so
// the derived lines (including diff hunks for edit tools) can be shared by
// the live painter, the row estimator, the bounded renderer, and static row
// counting instead of being recomputed for every visible row on each frame.
// The map key carries elision and the width-adaptive header budget.
const styledLinesCache = new WeakMap<
  NormalizedToolUse,
  Map<string, readonly ToolDisplayLine[]>
>();

export function toolUseStyledLines(
  toolUse: NormalizedToolUse,
  options: DisplayLineOptions = {},
): readonly ToolDisplayLine[] {
  const executionSummary =
    toolUse.toolName === 'executions' && options.executionLabels
      ? executionsSubagentSummary(toolUse.input, options.executionLabels)
      : undefined;
  const key = `${options.elide === false ? 'f' : 'e'}|${options.showOutput === true ? 'o' : 'h'}|${options.neutralStatus === true ? 'n' : 's'}|${options.width ?? 'd'}|${executionSummary ?? ''}`;
  let cached = styledLinesCache.get(toolUse);
  const hit = cached?.get(key);
  if (hit) return hit;
  const lines = buildStyledLines(toolUse, options, executionSummary);
  if (!cached) {
    cached = new Map();
    styledLinesCache.set(toolUse, cached);
  }
  cached.set(key, lines);
  return lines;
}

function lineText(line: ToolDisplayLine): readonly string[] {
  return line.kind === 'patch'
    ? line.textLines
    : [line.spans.map((span) => span.text).join('')];
}

/** Plain-text projection of the same styled lines, for row budgeting, static
 *  row counting, and ctrl+t full-output printing. */
export function toolUseDisplayLines(
  toolUse: NormalizedToolUse,
  options?: DisplayLineOptions,
): readonly string[] {
  return toolUseStyledLines(toolUse, options).flatMap(lineText);
}

/** Tool detail rows are separated from the next conversation entry. Derive
 *  that geometry from the same display-line model used by row budgeting. */
export function toolUseMarginBottomRows(toolUse: NormalizedToolUse): 0 | 1 {
  return toolUseDisplayLines(toolUse).length > 1 ? 1 : 0;
}
