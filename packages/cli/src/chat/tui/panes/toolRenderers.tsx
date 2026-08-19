// Tool-row rendering: one styled-line model is the single source of truth.
//
// The row's *content* is decided once, host-agnostically, by `toolRowModel`
// (`@shared/transcript`): header label and preview, the structured sections
// that describe the call, whether the output block is shown and why not. This
// module is only the terminal's paint of that model — spans (text +
// color/dim/bold) plus the head/tail elision the terminal spends its own
// height on. `toolUseStyledLines` builds the spans for the Ink painter in
// ToolUseRow; `toolUseDisplayLines` projects the same lines to plain text for
// the row-budget estimator, static row counting, and ctrl+t full-output
// printing. The patch preview (DiffView) is the one rich block that renders
// beyond its plain-text projection.

// Local imports - shared schemas and utilities
import {
  textDisplayWidth,
  truncateSummaryToWidth,
} from '@cli/runtime/terminalText';
import { COLOR_ERROR, COLOR_HINT, COLOR_SUCCESS } from '@cli/tui/ui/colors';
import {
  STATUS_DOT,
  TODO_DONE,
  TODO_PENDING,
  TOOL_OUTPUT_CORNER,
} from '@cli/tui/ui/glyphs';
import { TOOL_USE_STATUS } from '@shared/schemas';
import {
  transcriptText,
  type ToolRow,
  type ToolSection,
  type ToolSectionFile,
  type TranscriptText,
} from '@shared/transcript';
import {
  executionsSubagentSummary,
  type ExecutionLabels,
} from '@shared/tools/executionsDisplay';
import {
  isMcpToolName,
  normalizeToolName,
} from '@shared/tools/toolDisplayName';
import { toolDisplayKind } from '@shared/tools/toolKind';
import { buildDiffHunks } from '@utils/text/unifiedDiff';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local imports - CLI TUI rendering
import {
  diffDisplayLines,
  type InlinePatchGroup,
  wrappedDiffDisplayLines,
} from '../render/DiffView';
import { elidedTextLines } from '../render/transcriptRowLines';

const MAX_HEADER_PREVIEW = 80;
// Header chrome around the preview: `● ` plus ` (` and `)`.
const HEADER_CHROME_COLS = 5;
// Below this many remaining columns, drop the preview instead of overflowing
// the row.
const MIN_HEADER_PREVIEW = 4;
// The head/tail budget bounds line *count*. A tool's stdout can also be a
// single, arbitrarily long "line" with no newlines to elide against (e.g. a
// `rg` match inside a minified bundle) — cap each rendered line's width too,
// so one pathological line can't blow past the budget it was bounded by.
const OUTPUT_LINE_MAX_CHARS = 2000;

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

export interface DisplayLineOptions {
  /** When false, emit the full text of every block instead of the head+tail
   *  slice. The ctrl+t print path sets this to include everything. */
  readonly elide?: boolean;
  /** Terminal columns when the projection must match rich rendered rows. */
  readonly width?: number;
  /** Retained subagent identities used by executions wait/view headers. */
  readonly executionLabels?: ExecutionLabels;
  /** Suppressed-output tools in the full transcript: 'loaded' prepends the
   *  "Full output:" header, 'failed' shows the failure notice without it. */
  readonly compactOutput?: 'loaded' | 'failed';
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

const CORNER_PREFIX_SPAN: ToolDisplaySpan = Object.freeze({
  text: `${TOOL_OUTPUT_CORNER} `,
  dim: true,
});
const CONTINUATION_PREFIX_SPAN: ToolDisplaySpan = Object.freeze({
  text: '  ',
  dim: true,
});

/** One corner-opened block: the first line carries the `⎿` gutter, the rest
 *  align under it. */
function cornerRows(
  lines: readonly string[],
  color?: string,
): ToolDisplayLine[] {
  return lines.map((line, index) =>
    row([
      index === 0 ? CORNER_PREFIX_SPAN : CONTINUATION_PREFIX_SPAN,
      color === undefined ? { text: line } : { text: line, color },
    ]),
  );
}

/** The terminal's own budget over one of the row's untruncated texts. */
function elidedLines(text: TranscriptText, elide: boolean): string[] {
  return elidedTextLines(text, elide).map((line) =>
    truncateWithEllipsis(line, OUTPUT_LINE_MAX_CHARS),
  );
}

/** A labeled block that collapses onto its label when it is one line long. */
function labeledLines(
  label: string,
  text: TranscriptText,
  elide: boolean,
): string[] {
  const lines = elidedLines(text, elide);
  return lines.length === 1 ? [`${label} ${lines[0]}`] : [label, ...lines];
}

function toolStatusColor(model: ToolRow['model']): string | undefined {
  if (model.isError) return COLOR_ERROR;
  return model.status === TOOL_USE_STATUS.COMPLETED ? COLOR_SUCCESS : undefined;
}

/** The failure block: the error text when there is one, and a bare marker when
 *  a call failed without saying why. A user-feedback rejection has no error of
 *  its own — its `Feedback:` block is the whole story. */
function toolErrorLines(model: ToolRow['model'], elide: boolean): string[] {
  if (model.errorPreview) return elidedLines(model.errorPreview, elide);
  return model.isError && !model.isUserFeedback ? ['(error)'] : [];
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function labeled(label: string, value: string): string {
  return label ? `${label} ${value}` : value;
}

function sectionFileLine(file: ToolSectionFile): string {
  const from = file.from ? ` ← ${file.from}` : '';
  const note = file.note ? ` (${file.note})` : '';
  const changes = file.lineChanges
    ? ` (+${file.lineChanges.added}/-${file.lineChanges.removed})`
    : '';
  return `${file.path}${from}${note}${changes}`;
}

function sectionLines(section: ToolSection, elide: boolean): readonly string[] {
  switch (section.kind) {
    case 'identifier':
      return [
        labeled(
          section.label,
          `${section.value}${section.note ? ` (${section.note})` : ''}`,
        ),
      ];
    case 'status':
      return [labeled(section.label, section.status)];
    case 'badges':
      return [labeled(section.label, section.badges.join(', '))];
    case 'file': {
      const range =
        section.startLine === undefined
          ? ''
          : `:${section.startLine}${section.endLine === undefined ? '' : `-${section.endLine}`}`;
      // The path vocabulary matters in a terminal, where nothing is clickable:
      // a memory or execution path is not a workspace file.
      const namespace =
        section.namespace === 'workspace' ? '' : ` [${section.namespace}]`;
      return [labeled(section.label, `${section.path}${range}${namespace}`)];
    }
    case 'fileList':
      return [
        section.label,
        ...section.files.map((file) => `  ${sectionFileLine(file)}`),
      ];
    case 'checklist':
      return [
        section.label,
        ...section.items.map(
          (item) => `  ${item.done ? TODO_DONE : TODO_PENDING} ${item.text}`,
        ),
      ];
    case 'fileGroups':
      return [
        section.label,
        ...section.groups.map(
          (group) => `  ${group.label}: ${group.files.join(', ')}`,
        ),
      ];
    case 'text':
    case 'code':
      return section.label
        ? labeledLines(section.label, section.text, elide)
        : elidedLines(section.text, elide);
    case 'diff':
      // Rendered as a rich patch block, not as text rows.
      return [];
  }
}

/**
 * Sections the header already says. Row density is the terminal's half of the
 * shared model's contract, and both of these restate the header preview rather
 * than adding anything to it:
 *
 *  - a `file` section with no line range — `deriveToolInputPreview` read the
 *    very same `path`/`file_path` key to build the preview;
 *  - the unlabeled `shell`/`yaml` dump the shared default builder emits for a
 *    tool with no structured sections of its own.
 *
 * A file body (`file` language), a workflow script, and every labeled section
 * carry content of their own and always paint.
 */
function isHeaderRedundantSection(
  section: ToolSection,
  headerPreview: string,
): boolean {
  if (!headerPreview) return false;
  if (section.kind === 'file') {
    return section.startLine === undefined && section.endLine === undefined;
  }
  return (
    section.kind === 'code' &&
    section.label === '' &&
    (section.language === 'shell' || section.language === 'yaml')
  );
}

/**
 * The patch previews an edit-like call's diff sections describe. A failed edit
 * shows its error instead: the "before/after" it proposed never happened.
 */
function patchGroupsFromSections(
  sections: readonly ToolSection[],
  isError: boolean,
): readonly InlinePatchGroup[] | undefined {
  if (isError) return undefined;
  let fileLabel = 'edit';
  const groups: InlinePatchGroup[] = [];
  for (const section of sections) {
    if (section.kind === 'file') {
      if (section.path) fileLabel = section.path;
      continue;
    }
    if (section.kind !== 'diff') continue;
    const hunks = buildDiffHunks(section.oldText, section.newText);
    if (hunks.length > 0) groups.push({ fileLabel, hunks });
  }
  return groups.length > 0 ? groups : undefined;
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

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function buildStyledLines(
  { model, toolUse }: ToolRow,
  options: DisplayLineOptions,
  executionSummary: string | undefined,
): readonly ToolDisplayLine[] {
  const elide = options.elide !== false;
  const isBashKind = toolDisplayKind(toolUse.toolName) === 'bash';

  // Subagent labels exist only at paint time (they name live executions), so
  // the labeled summary is applied over the model's own header preview.
  const headerPreview = executionSummary ?? model.headerPreview;
  const budget =
    options.width === undefined
      ? MAX_HEADER_PREVIEW
      : toolHeaderPreviewBudget(options.width, model.headerLabel);
  const preview =
    budget > 0 && headerPreview
      ? truncateSummaryToWidth(headerPreview, budget)
      : '';
  const statusColor = toolStatusColor(model);

  const patchGroups = patchGroupsFromSections(model.sections, model.isError);
  const sectionRows = model.sections.flatMap((section) =>
    isHeaderRedundantSection(section, headerPreview)
      ? []
      : cornerRows(sectionLines(section, elide)),
  );

  // Output text is read from the payload rather than `model.output` so the
  // on-demand spill reader's substitution (which rewrites `toolUse.outputText`)
  // reaches the paint; the model still owns whether it is shown at all.
  const outputRows = model.showOutput
    ? cornerRows(elidedLines(transcriptText(toolUse.outputText), elide))
    : [];
  const exitCode = model.isError ? model.exitCode : undefined;
  const errorRows = cornerRows(toolErrorLines(model, elide), COLOR_ERROR);
  const feedbackRows = model.userInstruction
    ? cornerRows(labeledLines('Feedback:', model.userInstruction, elide))
    : [];
  // "It ran and printed nothing" is only meaningful for a call whose output is
  // the point: a shell command or an MCP call.
  const showNoOutput =
    model.outputSuppression === 'empty' &&
    !model.isError &&
    model.status === TOOL_USE_STATUS.COMPLETED &&
    (isBashKind || isMcpToolName(toolUse.toolName));

  const compactOutput: ToolDisplayLine[] = [];
  if (options.compactOutput !== undefined && !model.showOutput) {
    if (options.compactOutput === 'loaded') {
      compactOutput.push(row([{ text: 'Full output:' }]));
    }
    for (const line of toolUse.outputText.split('\n')) {
      compactOutput.push(row([{ text: line }]));
    }
  }

  return [
    row([
      { text: `${STATUS_DOT} `, color: statusColor, dim: !statusColor },
      { text: model.headerLabel, bold: true },
      ...(preview
        ? [
            {
              text: ` (${preview})`,
              color: isBashKind ? COLOR_HINT : undefined,
              dim: !isBashKind,
            },
          ]
        : []),
    ]),
    ...sectionRows,
    ...(patchGroups
      ? [
          {
            kind: 'patch' as const,
            groups: patchGroups,
            textLines: patchTextLines(patchGroups, options.width),
          },
        ]
      : []),
    ...outputRows,
    ...(exitCode !== undefined
      ? [
          row([
            CORNER_PREFIX_SPAN,
            { text: `exit ${exitCode}`, color: COLOR_ERROR },
          ]),
        ]
      : []),
    ...errorRows,
    ...feedbackRows,
    ...(showNoOutput
      ? [row([CORNER_PREFIX_SPAN, { text: '(no output)', dim: true }])]
      : []),
    ...compactOutput,
  ];
}

// Memoized per projected `ToolRow` object. The fold replaces a row object only
// when its source entry changed, so the derived lines (including diff hunks
// for edit tools) can be shared by the live painter, the row estimator, the
// bounded renderer, and static row counting instead of being recomputed for
// every visible row on each frame. The map key carries elision and the
// width-adaptive header budget.
const styledLinesCache = new WeakMap<
  ToolRow,
  Map<string, readonly ToolDisplayLine[]>
>();

export function toolUseStyledLines(
  toolRow: ToolRow,
  options: DisplayLineOptions = {},
): readonly ToolDisplayLine[] {
  const { toolUse } = toolRow;
  const executionSummary =
    normalizeToolName(toolUse.toolName) === 'executions' &&
    options.executionLabels
      ? executionsSubagentSummary(toolUse.input, options.executionLabels)
      : undefined;
  const key = `${options.elide === false ? 'f' : 'e'}|${options.compactOutput ?? 'n'}|${options.width ?? 'd'}|${executionSummary ?? ''}`;
  let cached = styledLinesCache.get(toolRow);
  const hit = cached?.get(key);
  if (hit) return hit;
  const lines = buildStyledLines(toolRow, options, executionSummary);
  if (!cached) {
    cached = new Map();
    styledLinesCache.set(toolRow, cached);
  }
  cached.set(key, lines);
  return lines;
}

/** Plain-text projection of the same styled lines, for row budgeting, static
 *  row counting, and ctrl+t full-output printing. */
export function toolUseDisplayLines(
  toolRow: ToolRow,
  options?: DisplayLineOptions,
): readonly string[] {
  return toolUseStyledLines(toolRow, options).flatMap((line) =>
    line.kind === 'patch'
      ? line.textLines
      : [line.spans.map((span) => span.text).join('')],
  );
}

/** Tool detail rows are separated from the next conversation entry. Derive
 *  that geometry from the same display-line model used by row budgeting. */
export function toolUseMarginBottomRows(toolRow: ToolRow): 0 | 1 {
  return toolUseDisplayLines(toolRow).length > 1 ? 1 : 0;
}
