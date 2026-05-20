// Renders the active stream's todo checklist and (if present) the numbered
// plan steps. Hidden when both lists are empty.

import { Box, Text } from 'ink';

import { TODO_STATUS, type TodoItem, type TodoStatus } from '@shared/schemas';

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

function TodoRow({ todo }: { todo: TodoItem }): React.JSX.Element {
  const label =
    todo.status === TODO_STATUS.IN_PROGRESS ? todo.activeForm : todo.content;
  return (
    <Box>
      <Text color={todoColor(todo.status)}>{todoMarker(todo.status)} </Text>
      <Text dimColor={todo.status === TODO_STATUS.COMPLETED}>{label}</Text>
    </Box>
  );
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
  if (props.maxRows !== undefined && props.maxRows <= 0) return null;

  return (
    <Box
      flexDirection="column"
      height={props.maxRows}
      overflowY={props.maxRows === undefined ? undefined : 'hidden'}
      paddingX={1}
      marginBottom={props.maxRows === undefined ? 1 : 0}
    >
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
          <Text dimColor>{plan.summary}</Text>
          {plan.steps.map((step, i) => (
            <Box key={i}>
              <Text color={todoColor(step.status)}>
                {todoMarker(step.status)}{' '}
              </Text>
              <Text>{`${i + 1}. ${step.title}`}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
