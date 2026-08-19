// Renders the active stream's todo checklist and (if present) a one-line
// plan summary. Hidden when both are empty.

import { Box, Text } from 'ink';

import { hiddenRowsText } from '@cli/tui/overflowText';
import { COLOR_HINT, COLOR_SUCCESS } from '@cli/tui/ui/colors';
import { TODO_ACTIVE, TODO_DONE, TODO_PENDING } from '@cli/tui/ui/glyphs';
import {
  TODO_STATUS,
  planSummaryLine,
  type Plan,
  type TodoItem,
  type TodoStatus,
} from '@shared/schemas';
import { assertNever } from '@utils/core';
import { pluralize } from '@utils/text/stringUtils';

// Marker glyph + color per todo status; statuses absent here (e.g. PENDING)
// fall back to the default empty box with no color.
const TODO_STATUS_DISPLAY: Partial<
  Record<TodoStatus, { marker: string; color: string }>
> = {
  [TODO_STATUS.COMPLETED]: { marker: TODO_DONE, color: COLOR_SUCCESS },
  [TODO_STATUS.IN_PROGRESS]: { marker: TODO_ACTIVE, color: COLOR_HINT },
};

function TodoRow({ todo }: { readonly todo: TodoItem }): React.JSX.Element {
  const label =
    todo.status === TODO_STATUS.IN_PROGRESS ? todo.activeForm : todo.content;
  const display = TODO_STATUS_DISPLAY[todo.status];
  return (
    <Box height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text color={display?.color}>{display?.marker ?? TODO_PENDING} </Text>
      </Box>
      <Text
        dimColor={todo.status === TODO_STATUS.COMPLETED}
        wrap="truncate-end"
      >
        {label}
      </Text>
    </Box>
  );
}

export type CompactTodosPlanRow =
  | { kind: 'todo'; sourceIndex: number; todo: TodoItem }
  | { kind: 'planSummary'; sourceIndex: number; summary: string };

// Sort priority by (row kind, status). Statuses absent for the todo kind use
// DEFAULT_TODO_ROW_PRIORITY; planSummary has a single fixed priority.
const COMPACT_TODO_ROW_PRIORITY: Partial<Record<TodoStatus, number>> = {
  [TODO_STATUS.IN_PROGRESS]: 0,
  [TODO_STATUS.PENDING]: 1,
  [TODO_STATUS.COMPLETED]: 4,
};
const DEFAULT_TODO_ROW_PRIORITY = 3;
const PLAN_SUMMARY_PRIORITY = 5;

function compactRowPriority(row: CompactTodosPlanRow): number {
  switch (row.kind) {
    case 'todo':
      return (
        COMPACT_TODO_ROW_PRIORITY[row.todo.status] ?? DEFAULT_TODO_ROW_PRIORITY
      );
    case 'planSummary':
      return PLAN_SUMMARY_PRIORITY;
    default:
      return assertNever(row, 'Unknown compact todos/plan row kind');
  }
}

export function compactTodosPlanRows({
  maxRows,
  plan,
  todos,
}: {
  readonly maxRows: number;
  readonly plan: Plan | null;
  readonly todos: readonly TodoItem[];
}): {
  readonly hiddenCount: number;
  readonly rows: readonly CompactTodosPlanRow[];
} {
  const rowBudget = Math.max(0, Math.floor(maxRows));
  const allRows: CompactTodosPlanRow[] = todos.map((todo, index) => ({
    kind: 'todo',
    sourceIndex: index,
    todo,
  }));
  if (plan) {
    allRows.push({
      kind: 'planSummary',
      sourceIndex: allRows.length,
      summary: planSummaryLine(plan.objective),
    });
  }

  if (allRows.length <= rowBudget) {
    return { hiddenCount: 0, rows: allRows };
  }
  if (rowBudget <= 0) {
    return { hiddenCount: allRows.length, rows: [] };
  }

  // At one row, show the highest-signal item instead of spending the only row
  // on the hidden-count marker.
  const visibleCount = rowBudget === 1 ? 1 : rowBudget - 1;
  const rows = [...allRows]
    .sort(
      (left, right) =>
        compactRowPriority(left) - compactRowPriority(right) ||
        left.sourceIndex - right.sourceIndex,
    )
    .slice(0, visibleCount)
    .sort((left, right) => left.sourceIndex - right.sourceIndex);

  return {
    hiddenCount: allRows.length - rows.length,
    rows,
  };
}

/**
 * Natural (uncapped) compact-row count for a slice's todos + plan: one row per
 * todo, plus one row for the plan summary. Drives the bottom-panel reservation
 * in App so the panel takes only the height it needs.
 */
export function todosPlanPanelRowCount(
  todos: readonly TodoItem[],
  plan: Plan | null,
): number {
  return todos.length + (plan ? 1 : 0);
}

function CompactRow({ row }: { row: CompactTodosPlanRow }): React.JSX.Element {
  switch (row.kind) {
    case 'todo':
      return <TodoRow todo={row.todo} />;
    case 'planSummary':
      return (
        <Box height={1} minWidth={0} overflowY="hidden">
          <Text dimColor wrap="truncate-end">
            {row.summary}
          </Text>
        </Box>
      );
  }
}

export interface TodosPlanPanelProps {
  readonly maxRows: number;
  readonly plan: Plan | null;
  readonly todos: readonly TodoItem[];
}

export function TodosPlanPanel({
  maxRows,
  plan,
  todos,
}: TodosPlanPanelProps): React.JSX.Element | null {
  if (todos.length === 0 && !plan) return null;
  // Like the child list above it, the panel owns one blank separator row so
  // the todo checklist never sits flush against its neighbor. If the gap and
  // one content row do not both fit, render nothing.
  const rowBudget = Math.max(0, Math.floor(maxRows)) - 1;
  if (rowBudget <= 0) return null;

  const { hiddenCount, rows } = compactTodosPlanRows({
    maxRows: rowBudget,
    plan,
    todos,
  });
  return (
    <Box
      flexDirection="column"
      height={rowBudget}
      marginTop={1}
      overflowY="hidden"
      paddingX={1}
    >
      {rows.map((row) => (
        <CompactRow key={`${row.kind}:${row.sourceIndex}`} row={row} />
      ))}
      {hiddenCount > 0 && rows.length < rowBudget ? (
        <Box height={1} minWidth={0} overflowY="hidden">
          <Text dimColor wrap="truncate-end">
            {hiddenRowsText(
              hiddenCount,
              pluralize(hiddenCount, 'todo/plan item', 'todo/plan items'),
            )}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
