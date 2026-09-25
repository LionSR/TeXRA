// Scrollable, read-only view of one stream's canonical plan and todos.

import { useInput, useWindowSize } from 'ink';

import { type SessionHandle } from '@agent/runtime';
import { isEscapeInput } from '@cli/tui/inputKeys';
import { ReaderPanel, readerLayout } from '@cli/tui/ui/BorderedPanel';
import { CLOSE_HINTS, READER_SCROLL_HINTS } from '@cli/tui/ui/KeyHints';
import {
  AgentCategory,
  STATUS_DISPLAY,
  type Plan,
  type RunId,
  type TodoItem,
} from '@shared/schemas';

import { formFrameWidth } from '../forms/_shared/FormFrame';
import { ScrollableModalText } from '../modals/ScrollableModalText';

const WORK_PLAN_LOADING_TEXT = 'Loading work plan…';

/** Render the complete work plan loaded from committed events. */
function formatWorkPlanReaderText(
  plan: Plan | null,
  todos: readonly TodoItem[],
): string {
  const todoLines =
    todos.length === 0
      ? ['(no todos)']
      : todos.map(
          (todo, index) =>
            `${index + 1}. [${STATUS_DISPLAY[todo.status].label}] ${todo.content}`,
        );
  return [
    'Objective',
    plan?.objective ?? '(no objective)',
    '',
    'Todos',
    ...todoLines,
  ].join('\n');
}

export function WorkPlanReader({
  availableRows,
  loading = false,
  onClose,
  runId,
  session,
  title,
}: {
  readonly availableRows: number;
  readonly loading?: boolean;
  readonly onClose: () => void;
  readonly runId: RunId;
  /** The chat's session the plan is read from, threaded from the App. */
  readonly session: SessionHandle;
  readonly title: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const run = loading ? undefined : session.runView(runId);
  const workPlan =
    run?.category === AgentCategory.ToolUse
      ? { plan: run.plan, todos: run.todos }
      : undefined;
  const layout = readerLayout({
    availableRows,
    frameWidth: formFrameWidth(columns),
    hints: loading ? CLOSE_HINTS : READER_SCROLL_HINTS,
    title,
  });
  const text = loading
    ? WORK_PLAN_LOADING_TEXT
    : formatWorkPlanReaderText(workPlan?.plan ?? null, workPlan?.todos ?? []);

  useInput((input, key) => {
    if (isEscapeInput(input, key)) onClose();
  });

  return (
    <ReaderPanel layout={layout} title={title}>
      {layout.bodyRows > 0 ? (
        <ScrollableModalText
          footerHints={layout.showFooter ? CLOSE_HINTS : undefined}
          hiddenNoun="work plan rows"
          marginWhenSpacious={false}
          maxRows={layout.bodyRows}
          minContentWidth={1}
          resetKey={runId}
          scrollHint="scroll"
          showScrollHints={false}
          text={text}
          width={layout.contentWidth}
        />
      ) : null}
    </ReaderPanel>
  );
}
