// Scrollable, read-only view of one stream's canonical plan and todos.

import { Box, Text, useInput, useWindowSize } from 'ink';

import { tryDefaultSession } from '@agent/runtime';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
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
  TODO_STATUS,
  type Plan,
  type StreamTabId,
  type TodoItem,
  type TodoStatus,
} from '@shared/schemas';
import type { WorkPlanProvenance } from '@transcript';

import { formFrameWidth } from '../forms/_shared/FormFrame';
import { ScrollableModalText } from '../modals/ScrollableModalText';

const TODO_STATUS_LABELS: Record<TodoStatus, string> = {
  [TODO_STATUS.PENDING]: 'pending',
  [TODO_STATUS.IN_PROGRESS]: 'in progress',
  [TODO_STATUS.COMPLETED]: 'completed',
};

const WORK_PLAN_LOADING_HINTS: readonly KeyHint[] = [
  { key: 'Esc', action: 'close' },
];
const WORK_PLAN_LOADING_TEXT = 'Loading work plan…';
const BORDER_ROWS = 2;
const FOOTER_MARGIN_ROWS = 1;

function wrappedRows(text: string, width: number): number {
  return wrapAnsiToWidth(text, Math.max(1, width)).split('\n').length;
}

/** Compute a frame that fits the terminal. `bodyRows` may be zero. */
export function workPlanReaderLayout({
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
  const footerRows = wrappedRows(keyHintsText(hints), width);
  const showFooter = rows >= BORDER_ROWS + 1 + FOOTER_MARGIN_ROWS + footerRows;
  const titleRows = wrappedRows(title, width);
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

/** `available` marks the fields this reader may present as facts; a field it
 *  omits is presented, an unavailable one is masked. */
export function formatWorkPlanReaderText(
  plan: Plan | null,
  todos: readonly TodoItem[],
  available?: WorkPlanProvenance,
): string {
  const objective =
    available?.plan === false
      ? '(objective unavailable)'
      : (plan?.objective ?? '(no objective)');
  let todoLines: string[];
  if (available?.todos === false) {
    todoLines = ['(todos unavailable)'];
  } else if (todos.length === 0) {
    todoLines = ['(no todos)'];
  } else {
    todoLines = todos.map(
      (todo, index) =>
        `${index + 1}. [${TODO_STATUS_LABELS[todo.status]}] ${todo.content}`,
    );
  }
  return ['Objective', objective, '', 'Todos', ...todoLines].join('\n');
}

export function WorkPlanReader({
  availableRows,
  provenanceAtOpen,
  loading = false,
  onClose,
  streamId,
  title,
}: {
  readonly availableRows: number;
  /** Present only when this reader opened from a partially failed load: the
   *  fields vouched for at that instant. Fields it excludes stay masked until
   *  the store establishes them — no promotion is pushed in from outside. */
  readonly provenanceAtOpen?: WorkPlanProvenance;
  readonly loading?: boolean;
  readonly onClose: () => void;
  readonly streamId: StreamTabId;
  readonly title: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const snapshots = loading ? undefined : tryDefaultSession()?.snapshots;
  const workPlan = snapshots?.getWorkPlan(streamId);
  // A field this reader's own load could not vouch for stays masked only while
  // the store still cannot vouch for it. Every event that establishes one — a
  // live todos/plan write, a completed preload, a resume load — bumps
  // `streamArtifactRevision`, so this re-read repaints with it.
  const established = snapshots?.workPlanProvenance(streamId);
  const available: WorkPlanProvenance | undefined = provenanceAtOpen && {
    plan: provenanceAtOpen.plan || established?.plan === true,
    todos: provenanceAtOpen.todos || established?.todos === true,
  };
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
    : formatWorkPlanReaderText(
        workPlan?.plan ?? null,
        workPlan?.todos ?? [],
        available,
      );

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
        resetKey={streamId}
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
