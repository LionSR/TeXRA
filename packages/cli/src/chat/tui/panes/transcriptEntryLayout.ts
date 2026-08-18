// Declarative conversation-entry geometry shared by Ink renderers, viewport
// budgeting, static scrollback, and print-once full output.

import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_HINT,
  COLOR_SUCCESS,
} from '@cli/tui/ui/colors';
import {
  CROSS,
  ERROR_ENTRY_PREFIX,
  SKIP_CIRCLE,
  STATUS_DIAMOND,
  STATUS_DOT,
  TICK,
  WARNING,
  TODO_ACTIVE,
  TODO_DONE,
  TODO_PENDING,
  TOOL_OUTPUT_CORNER,
  USER_ENTRY_PREFIX,
} from '@cli/tui/ui/glyphs';
import { textDisplayWidth } from '@cli/runtime/terminalText';
import type { WorkflowCallProgress } from '@shared/schemas';
import type { CompactionActivityStatus } from '@shared/streams/compactionActivityProjection';
import { formatWorkflowPhaseHeading } from '@shared/copy/workflowCall';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { isInquiryContinuationText } from './transcriptEntries';
import { loadedImageDisplayLines } from './loadedImageDisplay';
import { toolUseDisplayLines, toolUseMarginBottomRows } from './toolRenderers';
import type { ConversationEntry } from '../state/cliState';

const DEFAULT_TRANSCRIPT_COLUMNS = 80;
const USER_ENTRY_MARGIN_TOP_ROWS = 1;
const USER_ENTRY_MARGIN_BOTTOM_ROWS = 1;
const ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS = 0;
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
  activity: {
    firstPrefix: '',
    continuationPrefix: '  ',
    inset: 0,
    marginBottomRows: 0,
    marginTopRows: 0,
  },
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
  media: {
    firstPrefix: '',
    continuationPrefix: '  ',
    inset: 0,
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
    // Two spaces nest the task under the `◆` phase divider that heads it. The
    // first-line marker is per-status (WORKFLOW_TASK_STATUS_STYLE), so
    // `firstPrefix` carries the indent alone and continuation lines add the
    // marker's own width on top of it.
    firstPrefix: '  ',
    continuationPrefix: '    ',
    inset: 0,
    marginBottomRows: 0,
    marginTopRows: 0,
  },
} as const satisfies Record<TranscriptEntryRole, RoleGeometry>;

/** Marker glyph + color per compaction status. */
export const COMPACTION_ACTIVITY_STATUS_STYLE = {
  running: { marker: STATUS_DOT, color: COLOR_HINT },
  completed: { marker: TICK, color: COLOR_SUCCESS },
  failed: { marker: CROSS, color: COLOR_ERROR },
  cancelled: { marker: SKIP_CIRCLE, color: COLOR_BORDER },
  skipped: { marker: SKIP_CIRCLE, color: COLOR_BORDER },
  interrupted: { marker: WARNING, color: COLOR_ERROR },
} as const satisfies Record<
  CompactionActivityStatus,
  { readonly marker: string; readonly color: string | undefined }
>;

export const WORKFLOW_TASK_STATUS_STYLE = {
  planned: { marker: TODO_PENDING, color: undefined },
  running: { marker: TODO_ACTIVE, color: COLOR_HINT },
  completed: { marker: TODO_DONE, color: COLOR_SUCCESS },
  cached: { marker: TICK, color: COLOR_SUCCESS },
  skipped: { marker: SKIP_CIRCLE, color: COLOR_BORDER },
  cancelled: { marker: SKIP_CIRCLE, color: COLOR_BORDER },
  failed: { marker: CROSS, color: COLOR_ERROR },
} as const satisfies Record<
  WorkflowCallProgress['status'],
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
  const raw =
    width != null && Number.isFinite(width)
      ? width
      : DEFAULT_TRANSCRIPT_COLUMNS;
  return Math.max(1, Math.floor(raw) - inset);
}

function wrapWithPrefix(
  body: string,
  columns: number,
  firstPrefix: string,
  continuationPrefix: string,
): readonly string[] {
  // Budget against the wider gutter: roles like `phase` indent continuations
  // further than the first line, so wrapping to the first prefix alone would
  // push every wrapped row past `columns` and let the terminal re-wrap it.
  const gutter = Math.max(
    textDisplayWidth(firstPrefix),
    textDisplayWidth(continuationPrefix),
  );
  const width = Math.max(1, columns - gutter);
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
  // Keep only the tail that could occupy the visible rows, so a very long
  // stream does not pay for wrapping text the slice will discard anyway.
  const budget = Math.max(1, columns) * rows * 2;
  const windowed = text.length > budget ? text.slice(-budget) : text;
  return wrapAnsiToWidth(windowed, columns)
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
    case 'activity':
      return wrapWithPrefix(
        entry.text,
        columns,
        `${COMPACTION_ACTIVITY_STATUS_STYLE[entry.activity.status].marker} `,
        ROLE_GEOMETRY.activity.continuationPrefix,
      );
    case 'assistant': {
      const renderLiveTail =
        mode === 'live' || (mode === 'bounded' && !entry.finalized);
      if (renderLiveTail) {
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
    }
    case 'tool': {
      const useRichDisplay =
        mode === 'live' || mode === 'bounded' || mode === 'scrollback-budget';
      const lines = toolUseDisplayLines(entry.toolUse, {
        elide: mode !== 'scrollback-budget',
        executionLabels,
        ...(useRichDisplay ? { width: columns } : {}),
      });
      // Rich rows and their bounded fallback keep each display line on one
      // terminal row. Other modes paint the wrapped text projection directly.
      return useRichDisplay ? lines : wrapDisplayLines(lines, columns);
    }
    case 'media':
      return loadedImageDisplayLines(entry.images, columns);
    case 'phase':
      return wrapWithPrefix(
        `${STATUS_DIAMOND} ${formatWorkflowPhaseHeading(entry)}`,
        columns,
        ROLE_GEOMETRY.phase.firstPrefix,
        ROLE_GEOMETRY.phase.continuationPrefix,
      );
    case 'workflowTask':
      // The status marker belongs to the layout, not the Ink row: the print-once
      // scrollback snapshot is built from these lines.
      return wrapWithPrefix(
        entry.text,
        columns,
        `${ROLE_GEOMETRY.workflowTask.firstPrefix}${WORKFLOW_TASK_STATUS_STYLE[entry.task.status].marker} `,
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

/** Separator rows an entry declares below itself, without laying out its
 *  lines. Needed to collapse the next entry's top margin against it. */
function entryMarginBottomRows(entry: ConversationEntry): number {
  if (entry.role === 'tool') return toolUseMarginBottomRows(entry.toolUse);
  if (entry.role === 'user' && isInquiryContinuationText(entry.text)) return 0;
  return ROLE_GEOMETRY[entry.role].marginBottomRows;
}

/** Exposed for the static-scrollback budget walk, which needs the bottom
 *  margin of a previous entry to collapse the next entry's top margin without
 *  laying out that next entry a second time. */
export function transcriptEntryMarginBottomRows(
  entry: ConversationEntry,
): number {
  return entryMarginBottomRows(entry);
}

export function transcriptEntryLayout(
  entry: ConversationEntry,
  {
    colorEnabled,
    maxRows,
    mode = 'scrollback',
    executionLabels,
    previousEntry,
    width,
  }: {
    readonly colorEnabled?: boolean;
    readonly maxRows?: number;
    readonly mode?: TranscriptEntryLayoutMode;
    readonly executionLabels?: ExecutionLabels;
    /** The entry rendered directly above this one, when the caller knows it.
     *  Yoga does not collapse adjacent margins, so without this a boundary
     *  where both sides declare a separator costs two blank rows instead of
     *  one (user to user, user to phase, multi-line tool to phase). */
    readonly previousEntry?: ConversationEntry;
    readonly width?: number;
  } = {},
): TranscriptEntryLayout {
  const base = ROLE_GEOMETRY[entry.role];
  const inset = base.inset;
  const isInquiryContinuation =
    entry.role === 'user' && isInquiryContinuationText(entry.text);
  const declaredTopRows = isInquiryContinuation ? 0 : base.marginTopRows;
  const marginTopRows =
    previousEntry === undefined
      ? declaredTopRows
      : Math.max(0, declaredTopRows - entryMarginBottomRows(previousEntry));
  const marginBottomRows = entryMarginBottomRows(entry);
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
  // Spilled rows carry only a bounded preview in the normal transcript. The
  // on-demand reader substitutes the artifact text before reaching this
  // layout. Let the owning renderer append it for read/edit-style tools whose
  // compact card intentionally omits ordinary output.
  return {
    ...layout,
    lines: wrapDisplayLines(
      toolUseDisplayLines(entry.toolUse, {
        elide: false,
        executionLabels,
        // Gate the "Full output:" header on actual recovery: a failed spill
        // keeps the bounded preview plus failure notice, without the header.
        ...(entry.spillPath === undefined
          ? {}
          : {
              compactOutput: entry.spillFailed === true ? 'failed' : 'loaded',
            }),
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
  // Existing bounded tool rows omit their unbounded separators; user
  // bands retain margins whenever one content row still fits.
  const isUserRole = layout.role === 'user';
  const marginRows = isUserRole
    ? layout.marginTopRows + layout.marginBottomRows
    : 0;
  const includeMargins = rows > marginRows;
  const contentRows = Math.max(1, rows - (includeMargins ? marginRows : 0));
  return {
    ...layout,
    lines: layout.lines.slice(-contentRows),
    marginBottomRows:
      isUserRole && includeMargins ? layout.marginBottomRows : 0,
    marginTopRows: isUserRole && includeMargins ? layout.marginTopRows : 0,
  };
}
