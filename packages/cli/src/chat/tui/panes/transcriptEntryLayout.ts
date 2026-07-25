// Declarative conversation-entry geometry shared by Ink renderers, viewport
// budgeting, static scrollback, and print-once full output.

import type { WorkflowTaskProgress } from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_HINT,
  COLOR_SUCCESS,
} from '../ui/colors';
import {
  CROSS,
  ERROR_ENTRY_PREFIX,
  SKIP_CIRCLE,
  STATUS_DIAMOND,
  TICK,
  TODO_ACTIVE,
  TODO_DONE,
  TODO_PENDING,
  TOOL_OUTPUT_CORNER,
  USER_ENTRY_PREFIX,
} from '../ui/glyphs';
import { isInquiryContinuationText } from './transcriptEntries';
import { toolUseDisplayLines, toolUseMarginBottomRows } from './toolRenderers';
import type { ConversationEntry } from '../state/cliState';

const DEFAULT_TRANSCRIPT_COLUMNS = 80;
const USER_ENTRY_MARGIN_TOP_ROWS = 1;
const USER_ENTRY_MARGIN_BOTTOM_ROWS = 1;
const ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS = 0;
const PROCESS_ENTRY_MARGIN_BOTTOM_ROWS = 1;
export const LIVE_TAIL_ROWS = 24;

type TranscriptEntryRole = ConversationEntry['role'];
type TranscriptEntryLayoutMode =
  'bounded' | 'live' | 'scrollback' | 'scrollback-budget';

interface RoleGeometry {
  readonly firstPrefix: string;
  readonly continuationPrefix: string;
  readonly inset: number;
  readonly marginBottomRows: number;
  readonly marginTopRows: number;
}

const ROLE_GEOMETRY = {
  assistant: {
    firstPrefix: '',
    continuationPrefix: '',
    inset: 0,
    marginBottomRows: ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS,
    marginTopRows: 0,
  },
  error: {
    firstPrefix: ERROR_ENTRY_PREFIX,
    continuationPrefix: ' '.repeat(ERROR_ENTRY_PREFIX.length),
    inset: 2,
    marginBottomRows: 0,
    marginTopRows: 0,
  },
  phase: {
    firstPrefix: '',
    continuationPrefix: '  ',
    inset: 0,
    marginBottomRows: 0,
    marginTopRows: 1,
  },
  process: {
    firstPrefix: '',
    continuationPrefix: '',
    inset: 2,
    marginBottomRows: PROCESS_ENTRY_MARGIN_BOTTOM_ROWS,
    marginTopRows: 0,
  },
  tool: {
    firstPrefix: '',
    continuationPrefix: '',
    inset: 0,
    marginBottomRows: 0,
    marginTopRows: 0,
  },
  user: {
    firstPrefix: USER_ENTRY_PREFIX,
    continuationPrefix: ' '.repeat(USER_ENTRY_PREFIX.length),
    inset: 2,
    marginBottomRows: USER_ENTRY_MARGIN_BOTTOM_ROWS,
    marginTopRows: USER_ENTRY_MARGIN_TOP_ROWS,
  },
  workflowTask: {
    // The first-line marker is per-status (WORKFLOW_TASK_STATUS_STYLE), so the
    // role carries only the alignment used by wrapped continuation lines.
    firstPrefix: '',
    continuationPrefix: '  ',
    inset: 0,
    marginBottomRows: 0,
    marginTopRows: 0,
  },
} as const satisfies Record<TranscriptEntryRole, RoleGeometry>;

/**
 * Marker glyph + color per workflow-task status. Steady glyphs only — an
 * animated `running` marker would need a per-component timer, which repaints
 * the whole live region for no added information (see CHILD_STATUS_MARKER).
 * Exhaustive on purpose: a seventh status must break this build rather than
 * render an undefined marker.
 */
export const WORKFLOW_TASK_STATUS_STYLE = {
  planned: { marker: TODO_PENDING, color: undefined },
  running: { marker: TODO_ACTIVE, color: COLOR_HINT },
  completed: { marker: TODO_DONE, color: COLOR_SUCCESS },
  cached: { marker: TICK, color: COLOR_SUCCESS },
  skipped: { marker: SKIP_CIRCLE, color: COLOR_BORDER },
  failed: { marker: CROSS, color: COLOR_ERROR },
} as const satisfies Record<
  WorkflowTaskProgress['status'],
  { readonly marker: string; readonly color: string | undefined }
>;

export interface TranscriptEntryLayout {
  readonly columns: number;
  readonly inset: number;
  readonly lines: readonly string[];
  readonly marginBottomRows: number;
  readonly marginTopRows: number;
  readonly role: TranscriptEntryRole;
}

export function transcriptColumns(
  width: number | undefined,
  inset = 0,
): number {
  return Math.max(
    1,
    Math.floor(
      width == null || !Number.isFinite(width)
        ? DEFAULT_TRANSCRIPT_COLUMNS
        : width,
    ) - inset,
  );
}

function wrapWithPrefix(
  body: string,
  columns: number,
  firstPrefix: string,
  continuationPrefix: string,
): readonly string[] {
  const width = Math.max(1, columns - firstPrefix.length);
  return wrapAnsiToWidth(body, width)
    .split('\n')
    .map(
      (line, index) =>
        `${index === 0 ? firstPrefix : continuationPrefix}${line}`,
    );
}

const CORNER_PREFIX = `${TOOL_OUTPUT_CORNER} `;

function leadingWhitespacePrefix(line: string): string {
  return line.match(/^\s+/)?.[0] ?? '';
}

function wrapDisplayLine(line: string, columns: number): readonly string[] {
  if (line.startsWith(CORNER_PREFIX)) {
    return wrapWithPrefix(
      line.slice(CORNER_PREFIX.length),
      columns,
      CORNER_PREFIX,
      ' '.repeat(CORNER_PREFIX.length),
    );
  }
  const prefix = leadingWhitespacePrefix(line);
  return wrapWithPrefix(line.slice(prefix.length), columns, prefix, prefix);
}

function wrapDisplayLines(
  lines: readonly string[],
  columns: number,
): readonly string[] {
  return lines.flatMap((line) => wrapDisplayLine(line, columns));
}

function tailWindow(text: string, columns: number, tailRows: number): string {
  const budget = Math.max(1, columns) * tailRows * 2;
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
  const columns = transcriptColumns(width);
  return wrapAnsiToWidth(tailWindow(text, columns, rows), columns)
    .split('\n')
    .slice(-Math.max(1, rows));
}

function entryLines(
  entry: ConversationEntry,
  mode: TranscriptEntryLayoutMode,
  columns: number,
  colorEnabled: boolean | undefined,
  maxRows: number | undefined,
  executionLabels: ExecutionLabels | undefined,
): readonly string[] {
  switch (entry.role) {
    case 'assistant':
      if (mode === 'live' || (mode === 'bounded' && !entry.finalized)) {
        return liveAssistantDisplayLines({
          rows:
            mode === 'bounded' && maxRows !== undefined
              ? Math.max(1, maxRows)
              : LIVE_TAIL_ROWS,
          text: entry.text,
          width: columns,
        });
      }
      // Every other mode ('scrollback' | 'scrollback-budget' | finalized
      // 'bounded') renders through the Markdown pass.
      return renderAnsiMarkdown(entry.text, {
        width: columns,
        colorEnabled,
      }).split('\n');
    case 'tool': {
      const richProjection =
        mode === 'live' || mode === 'bounded' || mode === 'scrollback-budget';
      const lines = toolUseDisplayLines(entry.toolUse, {
        elide: mode !== 'scrollback-budget',
        executionLabels,
        ...(richProjection ? { width: columns } : {}),
      });
      // Rich rows and their bounded fallback keep each display line on one
      // terminal row. Other modes paint the wrapped text projection directly.
      return richProjection ? lines : wrapDisplayLines(lines, columns);
    }
    case 'process': {
      const lines = completedProcessDisplayLines(entry.process);
      return mode === 'live' || mode === 'bounded'
        ? lines
        : wrapDisplayLines(lines, columns);
    }
    case 'phase': {
      const suffix =
        entry.phaseIndex !== undefined && entry.phaseTotal !== undefined
          ? ` (${entry.phaseIndex + 1}/${entry.phaseTotal})`
          : '';
      const geometry = ROLE_GEOMETRY.phase;
      return wrapWithPrefix(
        `${STATUS_DIAMOND} ${entry.phaseLabel}${suffix}`,
        columns,
        geometry.firstPrefix,
        geometry.continuationPrefix,
      );
    }
    case 'workflowTask':
      // The status marker belongs to the layout, not the Ink row: the print-once
      // scrollback snapshot is built from these lines.
      return wrapWithPrefix(
        entry.text,
        columns,
        `${WORKFLOW_TASK_STATUS_STYLE[entry.task.status].marker} `,
        ROLE_GEOMETRY.workflowTask.continuationPrefix,
      );
    default: {
      const geometry = ROLE_GEOMETRY[entry.role];
      return wrapWithPrefix(
        entry.text,
        columns,
        geometry.firstPrefix,
        geometry.continuationPrefix,
      );
    }
  }
}

export function transcriptEntryLayout(
  entry: ConversationEntry,
  {
    colorEnabled,
    maxRows,
    mode = 'scrollback',
    executionLabels,
    width,
  }: {
    readonly colorEnabled?: boolean;
    readonly maxRows?: number;
    readonly mode?: TranscriptEntryLayoutMode;
    readonly executionLabels?: ExecutionLabels;
    readonly width?: number;
  } = {},
): TranscriptEntryLayout {
  const base = ROLE_GEOMETRY[entry.role];
  const inset = base.inset;
  const isInquiryContinuation =
    entry.role === 'user' && isInquiryContinuationText(entry.text);
  const marginTopRows = isInquiryContinuation ? 0 : base.marginTopRows;
  let marginBottomRows: number;
  if (entry.role === 'tool') {
    marginBottomRows = toolUseMarginBottomRows(entry.toolUse);
  } else if (isInquiryContinuation) {
    marginBottomRows = 0;
  } else {
    marginBottomRows = base.marginBottomRows;
  }
  const columns = transcriptColumns(width, inset);
  return {
    columns,
    lines: entryLines(
      entry,
      mode,
      columns,
      colorEnabled,
      maxRows,
      executionLabels,
    ),
    inset,
    marginBottomRows,
    marginTopRows,
    role: entry.role,
  };
}

/** Full-fidelity text layout for a transcript snapshot printed to scrollback. */
export function fullTranscriptEntryLayout(
  entry: ConversationEntry,
  width: number,
  executionLabels?: ExecutionLabels,
): TranscriptEntryLayout {
  // Ordinary Ink rows spend this inset as paddingX. Printed text has no Box
  // padding, so add it back before the shared layout subtracts it.
  const printWidth = width + ROLE_GEOMETRY[entry.role].inset;
  const layout = transcriptEntryLayout(entry, {
    mode: 'scrollback-budget',
    executionLabels,
    width: printWidth,
  });
  if (entry.role !== 'tool') return layout;
  return {
    ...layout,
    lines: wrapDisplayLines(
      toolUseDisplayLines(entry.toolUse, {
        elide: false,
        executionLabels,
      }),
      layout.columns,
    ),
  };
}

export function transcriptEntryLayoutRows(
  layout: TranscriptEntryLayout,
): number {
  return (
    Math.max(1, layout.lines.length) +
    layout.marginTopRows +
    layout.marginBottomRows
  );
}

export function boundedTranscriptEntryLayout(
  layout: TranscriptEntryLayout,
  maxRows: number,
): TranscriptEntryLayout {
  const rows = Math.max(1, maxRows);
  // Existing bounded process/tool rows omit their unbounded separators; user
  // bands retain margins whenever one content row still fits.
  const marginRows =
    layout.role === 'user' ? layout.marginTopRows + layout.marginBottomRows : 0;
  const includeMargins = rows > marginRows;
  const contentRows = Math.max(1, rows - (includeMargins ? marginRows : 0));
  return {
    ...layout,
    lines: layout.lines.slice(-contentRows),
    marginBottomRows:
      layout.role === 'user' && includeMargins ? layout.marginBottomRows : 0,
    marginTopRows:
      layout.role === 'user' && includeMargins ? layout.marginTopRows : 0,
  };
}
