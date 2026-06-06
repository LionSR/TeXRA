// Renders the active stream's todo checklist and (if present) the numbered
// plan steps. Hidden when both lists are empty.

import { Box, Text } from 'ink';

import {
  TODO_STATUS,
  type Plan,
  type PlanStep,
  type TodoItem,
  type TodoStatus,
} from '@shared/schemas';

import { cliState } from '../state/cliState';
import { useSignal } from '../state/useSignal';

function todoMarker(status: TodoStatus): string {
  switch (status) {
    case TODO_STATUS.COMPLETED:
      return '☑';
    case TODO_STATUS.IN_PROGRESS:
      return '☐';
    default:
      return '□';
  }
}

function todoColor(status: TodoStatus): string | undefined {
  switch (status) {
    case TODO_STATUS.COMPLETED:
      return 'green';
    case TODO_STATUS.IN_PROGRESS:
      return 'cyan';
    default:
      return undefined;
  }
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
  | { kind: 'planSummary'; sourceIndex: number; summary: string }
  | {
      kind: 'planStep';
      sourceIndex: number;
      step: PlanStep;
      stepIndex: number;
    };

function compactRowPriority(row: CompactTodosPlanRow): number {
  switch (row.kind) {
    case 'todo':
      switch (row.todo.status) {
        case TODO_STATUS.IN_PROGRESS:
          return 0;
        case TODO_STATUS.PENDING:
          return 1;
        case TODO_STATUS.COMPLETED:
          return 4;
        default:
          return 3;
      }
    case 'planStep':
      switch (row.step.status) {
        case TODO_STATUS.IN_PROGRESS:
          return 2;
        case TODO_STATUS.PENDING:
          return 3;
        case TODO_STATUS.COMPLETED:
          return 6;
        default:
          return 3;
      }
    case 'planSummary':
      return 5;
  }
  const exhaustive: never = row;
  return exhaustive;
}

function normalizedTaskLabel(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function todoLabels(todos: readonly TodoItem[]): ReadonlySet<string> {
  const labels = new Set<string>();
  for (const todo of todos) {
    labels.add(normalizedTaskLabel(todo.content));
    labels.add(normalizedTaskLabel(todo.activeForm));
  }
  labels.delete('');
  return labels;
}

export function todosPlanDisplayRows({
  plan,
  todos,
}: {
  readonly plan: Plan | null;
  readonly todos: readonly TodoItem[];
}): readonly CompactTodosPlanRow[] {
  const rows: CompactTodosPlanRow[] = todos.map((todo, index) => ({
    kind: 'todo',
    sourceIndex: index,
    todo,
  }));
  if (!plan) return rows;

  const duplicateTodoLabels = todoLabels(todos);
  rows.push({
    kind: 'planSummary',
    sourceIndex: rows.length,
    summary: plan.summary,
  });
  for (const [stepIndex, step] of plan.steps.entries()) {
    if (duplicateTodoLabels.has(normalizedTaskLabel(step.title))) continue;
    rows.push({
      kind: 'planStep',
      sourceIndex: rows.length,
      step,
      stepIndex,
    });
  }
  return rows;
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
  const allRows = todosPlanDisplayRows({ plan, todos });

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
 * Natural (uncapped) compact-row count for the deduplicated display model.
 * Drives the bottom-panel reservation in App so the panel takes only the height
 * it needs.
 */
export function todosPlanPanelRowCount(
  todos: readonly TodoItem[],
  plan: Plan | null,
): number {
  return todosPlanDisplayRows({ plan, todos }).length;
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
    case 'planStep':
      return (
        <Box height={1} minWidth={0} overflowY="hidden">
          <Box flexShrink={0}>
            <Text color={todoColor(row.step.status)}>
              {todoMarker(row.step.status)}{' '}
            </Text>
          </Box>
          <Text wrap="truncate-end">{`${row.stepIndex + 1}. ${row.step.title}`}</Text>
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
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  if (!slice) return null;
  const { todos, plan } = slice;
  if (todos.length === 0 && !plan) return null;
  const rowBudget =
    props.maxRows === undefined
      ? undefined
      : Math.max(0, Math.floor(props.maxRows));
  if (rowBudget !== undefined && rowBudget <= 0) return null;
  const displayRows = todosPlanDisplayRows({ plan, todos });
  if (displayRows.length === 0) return null;
  const hasTodoRows = displayRows.some((row) => row.kind === 'todo');
  const hasPlanRows = displayRows.some((row) => row.kind !== 'todo');

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
            >{`+${hiddenCount} more todo/plan item${hiddenCount === 1 ? '' : 's'}`}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      height={props.maxRows}
      overflowY={props.maxRows === undefined ? undefined : 'hidden'}
      paddingX={1}
      marginBottom={props.maxRows === undefined ? 1 : 0}
    >
      {hasTodoRows ? (
        <Box flexDirection="column">
          <Text bold dimColor>
            Todos
          </Text>
          {displayRows.map((row) =>
            row.kind === 'todo' ? (
              <TodoRow key={`todo:${row.sourceIndex}`} todo={row.todo} />
            ) : null,
          )}
        </Box>
      ) : null}
      {hasPlanRows ? (
        <Box flexDirection="column" marginTop={hasTodoRows ? 1 : 0}>
          <Text bold dimColor>
            Plan
          </Text>
          {displayRows.map((row) => {
            switch (row.kind) {
              case 'planSummary':
                return (
                  <Text key={`plan-summary:${row.sourceIndex}`} dimColor>
                    {row.summary}
                  </Text>
                );
              case 'planStep':
                return (
                  <Box key={`plan-step:${row.sourceIndex}`}>
                    <Text color={todoColor(row.step.status)}>
                      {todoMarker(row.step.status)}{' '}
                    </Text>
                    <Text>{`${row.stepIndex + 1}. ${row.step.title}`}</Text>
                  </Box>
                );
              case 'todo':
                return null;
            }
          })}
        </Box>
      ) : null}
    </Box>
  );
}
