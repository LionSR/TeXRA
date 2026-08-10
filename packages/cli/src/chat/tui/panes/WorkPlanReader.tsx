// Scrollable, read-only view of one stream's canonical plan and todos.

import { useInput, useWindowSize } from 'ink';

import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import {
  KeyHints,
  KEY_HINT_SEPARATOR,
  keyHintText,
  type KeyHint,
} from '@cli/tui/ui/KeyHints';
import { CONFIRM_CARD_HORIZONTAL_DECORATION } from '@cli/tui/ui/theme';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import {
  TODO_STATUS,
  type Plan,
  type StreamTabId,
  type TodoItem,
  type TodoStatus,
} from '@shared/schemas';

import { formFrameWidth } from '../forms/_shared/FormFrame';
import { isEscapeInput } from '../input/inputKeys';
import { ScrollableModalText } from '../modals/ScrollableModalText';
import { streams as streamsSignal } from '../state/cliState';
import { useSignal } from '../state/useSignal';

const TODO_STATUS_LABELS: Record<TodoStatus, string> = {
  [TODO_STATUS.PENDING]: 'pending',
  [TODO_STATUS.IN_PROGRESS]: 'in progress',
  [TODO_STATUS.COMPLETED]: 'completed',
};

const WORK_PLAN_READER_HINTS: readonly KeyHint[] = [
  { key: '↑/↓', action: 'scroll' },
  { key: 'PgUp/PgDn', action: 'page' },
  { key: 'Esc', action: 'close' },
];
const WORK_PLAN_LOADING_HINTS: readonly KeyHint[] = [
  { key: 'Esc', action: 'close' },
];
const WORK_PLAN_LOADING_TEXT = 'Loading work plan…';
const BORDER_ROWS = 2;
const FOOTER_MARGIN_ROWS = 1;

function wrappedRows(text: string, width: number): number {
  return wrapAnsiToWidth(text, Math.max(1, width)).split('\n').length;
}

export function workPlanReaderLayout({
  availableRows,
  contentWidth,
  hints = WORK_PLAN_READER_HINTS,
  title,
}: {
  readonly availableRows: number;
  readonly contentWidth: number;
  readonly hints?: readonly KeyHint[];
  readonly title: string;
}): {
  readonly bodyRows: number;
  readonly showFooter: boolean;
  readonly showTitle: boolean;
} {
  const rows = Math.max(1, Math.floor(availableRows));
  const width = Math.max(1, Math.floor(contentWidth));
  const footerRows = wrappedRows(
    hints.map(keyHintText).join(KEY_HINT_SEPARATOR),
    width,
  );
  const showFooter = rows >= BORDER_ROWS + 1 + FOOTER_MARGIN_ROWS + footerRows;
  const titleRows = wrappedRows(title, width);
  const footerFixedRows = showFooter ? FOOTER_MARGIN_ROWS + footerRows : 0;
  const showTitle = rows >= BORDER_ROWS + 1 + footerFixedRows + titleRows;
  return {
    bodyRows: Math.max(
      1,
      rows - BORDER_ROWS - footerFixedRows - (showTitle ? titleRows : 0),
    ),
    showFooter,
    showTitle,
  };
}

export function workPlanReaderTitle(label: string | undefined): string {
  return label ? `Work plan: ${label}` : 'Work plan';
}

export function formatWorkPlanReaderText(
  plan: Plan | null,
  todos: readonly TodoItem[],
): string {
  const objective = plan?.objective ?? '(no objective)';
  const todoLines = todos.length
    ? todos.map(
        (todo, index) =>
          `${index + 1}. [${TODO_STATUS_LABELS[todo.status]}] ${todo.content}`,
      )
    : ['(no todos)'];
  return ['Objective', objective, '', 'Todos', ...todoLines].join('\n');
}

export function WorkPlanReader({
  availableRows,
  loading = false,
  onClose,
  streamId,
  title,
}: {
  readonly availableRows: number;
  readonly loading?: boolean;
  readonly onClose: () => void;
  readonly streamId: StreamTabId;
  readonly title: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const streams = useSignal(streamsSignal);
  const slice = streams.get(streamId);
  const frameWidth = formFrameWidth(columns);
  const width = Math.max(1, frameWidth - CONFIRM_CARD_HORIZONTAL_DECORATION);
  const hints = loading ? WORK_PLAN_LOADING_HINTS : WORK_PLAN_READER_HINTS;
  const layout = workPlanReaderLayout({
    availableRows,
    contentWidth: width,
    hints,
    title,
  });
  const text = loading
    ? WORK_PLAN_LOADING_TEXT
    : formatWorkPlanReaderText(slice?.plan ?? null, slice?.todos ?? []);

  useInput((input, key) => {
    if (isEscapeInput(input, key)) onClose();
  });

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
      <ScrollableModalText
        hiddenNoun="work plan rows"
        marginWhenSpacious={false}
        maxRows={layout.bodyRows}
        minContentWidth={1}
        resetKey={streamId}
        scrollHint="scroll work plan"
        showScrollHints={false}
        text={text}
        width={width}
      />
    </BorderedPanel>
  );
}
