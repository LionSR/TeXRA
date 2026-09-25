// Scrollable, read-only view of one stream's canonical plan and todos.

import { Box, Text, useInput, useWindowSize } from 'ink';

import { type SessionHandle } from '@agent/runtime';
import { wrappedRowCount } from '@cli/tui/ansiWrap';
import { isEscapeInput } from '@cli/tui/inputKeys';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import {
  KeyHints,
  keyHintsText,
  READER_SCROLL_HINTS,
  type KeyHint,
} from '@cli/tui/ui/KeyHints';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { CONFIRM_CARD_HORIZONTAL_DECORATION } from '@cli/tui/ui/theme';
import {
  AgentCategory,
  STATUS_DISPLAY,
  type Plan,
  type RunId,
  type TodoItem,
} from '@shared/schemas';

import { formFrameWidth } from '../forms/_shared/FormFrame';
import { ScrollableModalText } from '../modals/ScrollableModalText';

const WORK_PLAN_LOADING_HINTS: readonly KeyHint[] = [
  { key: 'Esc', action: 'close' },
];
const WORK_PLAN_LOADING_TEXT = 'Loading work plan…';
const BORDER_ROWS = 2;
const FOOTER_MARGIN_ROWS = 1;

/** Compute a frame that fits the terminal. `bodyRows` may be zero. */
function workPlanReaderLayout({
  availableRows,
  contentWidth,
  hints = READER_SCROLL_HINTS,
  title,
}: {
  readonly availableRows: number;
  readonly contentWidth: number;
  readonly hints?: readonly KeyHint[];
  readonly title: string;
}): {
  readonly bodyRows: number;
  readonly showBorder: boolean;
  readonly showFooter: boolean;
  readonly showTitle: boolean;
} {
  const rows = Math.max(1, Math.floor(availableRows));
  const width = Math.max(1, Math.floor(contentWidth));
  if (rows < 4) {
    return {
      bodyRows: rows - 1,
      showBorder: false,
      showFooter: false,
      showTitle: true,
    };
  }
  const footerRows = wrappedRowCount(keyHintsText(hints), width);
  const showFooter = rows >= BORDER_ROWS + 1 + FOOTER_MARGIN_ROWS + footerRows;
  const titleRows = wrappedRowCount(title, width);
  const footerFixedRows = showFooter ? FOOTER_MARGIN_ROWS + footerRows : 0;
  const showTitle = rows >= BORDER_ROWS + 1 + footerFixedRows + titleRows;
  return {
    bodyRows: Math.max(
      1,
      rows - BORDER_ROWS - footerFixedRows - (showTitle ? titleRows : 0),
    ),
    showBorder: true,
    showFooter,
    showTitle,
  };
}

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
  const frameWidth = formFrameWidth(columns);
  const width = Math.max(1, frameWidth - CONFIRM_CARD_HORIZONTAL_DECORATION);
  const hints = loading ? WORK_PLAN_LOADING_HINTS : READER_SCROLL_HINTS;
  const layout = workPlanReaderLayout({
    availableRows,
    contentWidth: width,
    hints,
    title,
  });
  const text = loading
    ? WORK_PLAN_LOADING_TEXT
    : formatWorkPlanReaderText(workPlan?.plan ?? null, workPlan?.todos ?? []);

  useInput((input, key) => {
    if (isEscapeInput(input, key)) onClose();
  });

  const body =
    layout.bodyRows > 0 ? (
      <ScrollableModalText
        hiddenNoun="work plan rows"
        marginWhenSpacious={false}
        maxRows={layout.bodyRows}
        minContentWidth={1}
        resetKey={runId}
        scrollHint="scroll work plan"
        showScrollHints={false}
        text={text}
        width={layout.showBorder ? width : frameWidth}
      />
    ) : null;

  if (!layout.showBorder) {
    return (
      <Box
        flexDirection="column"
        height={Math.max(1, Math.floor(availableRows))}
        width={frameWidth}
      >
        <Text bold color={COLOR_HINT} wrap="truncate-end">
          {title}
        </Text>
        {body}
      </Box>
    );
  }

  return (
    <BorderedPanel
      color={COLOR_HINT}
      title={layout.showTitle ? title : undefined}
      width={frameWidth}
      footer={
        layout.showFooter ? (
          <KeyHints hints={hints} confirmCancel={false} wrap />
        ) : undefined
      }
    >
      {body}
    </BorderedPanel>
  );
}
