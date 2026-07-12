// Renders the active stream's todo checklist and (if present) a one-line
// plan summary. Hidden when both are empty.

import { Box, Text } from 'ink';

import {
  TODO_STATUS,
  planSummaryLine,
  type Plan,
  type TodoItem,
  type TodoStatus,
} from '@shared/schemas';

import {
  activeStreamId as activeStreamIdSignal,
  streams as streamsSignal,
} from '../state/cliState';
import { useSignal } from '../state/useSignal';
import { TODO_ACTIVE, TODO_DONE, TODO_PENDING } from '../ui/glyphs';

// Marker glyph + color per todo status; statuses absent here (e.g. PENDING)
// fall back to the default empty box with no color.
const TODO_STATUS_DISPLAY: Partial<
  Record<TodoStatus, { marker: string; color: string }>
> = {
  [TODO_STATUS.COMPLETED]: { marker: TODO_DONE, color: 'green' },
  [TODO_STATUS.IN_PROGRESS]: { marker: TODO_ACTIVE, color: 'cyan' },
};

function todoMarker(status: TodoStatus): string {
  return TODO_STATUS_DISPLAY[status]?.marker ?? TODO_PENDING;
}

function todoColor(status: TodoStatus): string | undefined {
  return TODO_STATUS_DISPLAY[status]?.color;
}

function TodoRow({
  compact = false,
  todo,
}: {
  readonly compact?: boolean;
  readonly todo: TodoItem;
}): React.JSX.Element {
  const label =
    todo.status === TODO_STATUS.IN_PROGRESS ? todo.activeForm : todo.content;
  return (
    <Box
      height={compact ? 1 : undefined}
      minWidth={0}
      overflowY={compact ? 'hidden' : undefined}
    >
      <Box flexShrink={0}>
        <Text color={todoColor(todo.status)}>{todoMarker(todo.status)} </Text>
      </Box>
      <Text
        dimColor={todo.status === TODO_STATUS.COMPLETED}
        wrap={compact ? 'truncate-end' : undefined}
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
  }
  const exhaustive: never = row;
  return exhaustive;
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
      return <TodoRow compact todo={row.todo} />;
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
  readonly maxRows?: number;
}

export function TodosPlanPanel(
  props: TodosPlanPanelProps = {},
): React.JSX.Element | null {
  const activeStreamId = useSignal(activeStreamIdSignal);
  const streams = useSignal(streamsSignal);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  if (!slice) return null;
  const { todos, plan } = slice;
  if (todos.length === 0 && !plan) return null;
  const rowBudget =
    props.maxRows === undefined
      ? undefined
      : Math.max(0, Math.floor(props.maxRows));
  if (rowBudget !== undefined && rowBudget <= 0) return null;

  if (rowBudget !== undefined) {
    const { hiddenCount, rows } = compactTodosPlanRows({
      maxRows: rowBudget,
      plan,
      todos,
    });
    return (
      <Box
        flexDirection="column"
        height={rowBudget}
        overflowY="hidden"
        paddingX={1}
      >
        {rows.map((row) => (
          <CompactRow key={`${row.kind}:${row.sourceIndex}`} row={row} />
        ))}
        {hiddenCount > 0 && rows.length < rowBudget ? (
          <Box height={1} minWidth={0} overflowY="hidden">
            <Text
              dimColor
              wrap="truncate-end"
            >{`… +${hiddenCount} more todo/plan item${hiddenCount === 1 ? '' : 's'}`}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // Reached only when maxRows is undefined (the compact branch above owns every
  // bounded case), so the panel renders uncapped with a trailing margin.
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {todos.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>
            Todos
          </Text>
          {todos.map((todo, i) => (
            <TodoRow key={i} todo={todo} />
          ))}
        </Box>
      ) : null}
      {plan ? (
        <Box flexDirection="column" marginTop={todos.length > 0 ? 1 : 0}>
          <Text bold dimColor>
            Plan
          </Text>
          <Text dimColor>{planSummaryLine(plan.objective)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
