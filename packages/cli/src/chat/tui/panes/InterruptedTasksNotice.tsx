// The open-time prompt above the input (GUI design 2026-10-02, J5): the tasks
// a closed or crashed TeXRA left interrupted, from the shared list
// (`@ui/copy/interruptedTasks`), with what blocks each and where to fix it.
// It answers through `/resume all` and `/resume`, never through single keys:
// a key on an input the user types into would fire on the first letter of a
// message. Anything sent hides it until the next open.

import { Box, Text } from 'ink';

import { hiddenRowsText } from '@cli/tui/overflowText';
import { truncateSummaryToWidth } from '@cli/runtime/terminalText';
import {
  INTERRUPTED_NOTICE,
  resumeBlockerLine,
  type InterruptedTask,
} from '@ui/copy/interruptedTasks';
import { formatRelativeTime, pluralize } from '@utils/text/stringUtils';

/** The heading, the task lines and the actions line, at most this many. */
const NOTICE_MAX_ROWS = 6;
/** Fewer rows than the heading, one line and the actions show nothing. */
export const NOTICE_MIN_ROWS = 3;

/** The rows the notice takes for `tasks`: none when there are none. */
export function interruptedNoticeRowCount(
  tasks: readonly InterruptedTask[],
): number {
  if (tasks.length === 0) return 0;
  return Math.min(NOTICE_MAX_ROWS, tasks.length + 2);
}

function taskLine(task: InterruptedTask): string {
  return [
    task.title,
    task.stoppedAt === null
      ? undefined
      : `stopped ${formatRelativeTime(task.stoppedAt)}`,
    task.agents ?? undefined,
    task.blocked
      ? `${resumeBlockerLine(task.blocked)}${task.blocked.kind === 'agentMissing' ? '' : ': /plugins'}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function InterruptedTasksNotice({
  maxRows,
  tasks,
  width,
}: {
  readonly maxRows: number;
  readonly tasks: readonly InterruptedTask[];
  readonly width: number;
}): React.JSX.Element | null {
  if (tasks.length === 0 || maxRows < NOTICE_MIN_ROWS) return null;
  const contentWidth = Math.max(0, width - 4);
  // Between the heading and the actions line: the tasks, the last slot
  // given to the count of those that do not fit.
  const slots = maxRows - 2;
  const overflow = tasks.length > slots;
  const shown = tasks.slice(0, overflow ? slots - 1 : slots);
  const hidden = tasks.length - shown.length;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">
        {INTERRUPTED_NOTICE.heading(tasks.length)}
      </Text>
      {shown.map((task) => (
        <Text key={task.runId} wrap="truncate-end">
          {'  '}
          {truncateSummaryToWidth(taskLine(task), contentWidth)}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor wrap="truncate-end">
          {'  '}
          {hiddenRowsText(hidden, pluralize(hidden, 'task', 'tasks'))}
        </Text>
      ) : null}
      <Text dimColor wrap="truncate-end">
        {'  '}
        {INTERRUPTED_NOTICE.tuiActions(tasks.length)}
      </Text>
    </Box>
  );
}
