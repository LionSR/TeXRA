// Task detail view for the CLI child execution controls.

// Third-party imports
import { useEffect, useState } from 'react';

import { Box, Text, useInput } from 'ink';

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

// Local imports - CLI state and UI
import { isJumpToBottomInput, isJumpToTopInput } from '../input/inputKeys';
import {
  childPickerKeyAction,
  type ChildControlItem,
} from '../state/childControls';
import {
  jumpTaskDetailScrollState,
  moveTaskDetailScrollState,
  pageTaskDetailScrollState,
  syncTaskDetailScrollState,
  taskDetailFollowTailScrollOffsetForColumns,
  taskDetailInitialScrollOffset,
  taskDetailScrollableOutputRowCountForColumns,
  taskDetailScrollContextKey,
  taskDetailVisibleOutputRowsFromOffsetForColumns,
  taskDetailVisibleScrollOffset,
  type TaskDetailScrollContext,
  type TaskDetailScrollState,
} from '../state/taskDetailScroll';
import { KeyHints, type KeyHint } from '../ui/KeyHints';
import { BorderedPanel } from '../ui/BorderedPanel';

export const TASK_DETAIL_LABEL_WIDTH = 13;
const ULTRA_COMPACT_TASK_DETAIL_MAX_ROWS = 4;
const NARROW_TASK_DETAIL_HINT_MAX_COLUMNS = 56;
const MIN_COLUMNS_FOR_KILL_HINT = 44;
// PgUp/PgDn and g/G are the least essential task-detail hints — they
// duplicate `TranscriptViewer`'s paging bindings but the arrow-key scroll
// hint above already covers the same affordance more compactly. Only surface
// them once there's room for the full hint row (scroll + page + top/bottom +
// focus stream + kill + back) without crowding out the higher-priority ones.
const MIN_COLUMNS_FOR_PAGE_JUMP_HINTS = 84;

export function isUltraCompactTaskDetailRows(
  availableRows: number | undefined,
): boolean {
  return (
    availableRows !== undefined &&
    availableRows <= ULTRA_COMPACT_TASK_DETAIL_MAX_ROWS
  );
}

export function taskDetailKeyHintsForColumns({
  availableColumns,
  canFocusStream,
  canKill,
  showScrollHint,
}: {
  readonly availableColumns?: number;
  readonly canFocusStream: boolean;
  readonly canKill: boolean;
  readonly showScrollHint: boolean;
}): readonly KeyHint[] {
  const narrow =
    availableColumns !== undefined &&
    availableColumns <= NARROW_TASK_DETAIL_HINT_MAX_COLUMNS;
  const hints: KeyHint[] = [];
  if (showScrollHint) hints.push({ key: '↑/↓', action: 'scroll' });
  if (
    showScrollHint &&
    (availableColumns === undefined ||
      availableColumns >= MIN_COLUMNS_FOR_PAGE_JUMP_HINTS)
  ) {
    hints.push({ key: 'PgUp/PgDn', action: 'page' });
    hints.push({ key: 'g/G', action: 'top/bottom' });
  }
  if (canFocusStream) {
    hints.push({ key: 'f', action: narrow ? 'focus' : 'focus stream' });
  }
  if (
    canKill &&
    (!narrow ||
      availableColumns === undefined ||
      availableColumns >= MIN_COLUMNS_FOR_KILL_HINT)
  ) {
    hints.push({ key: 'k', action: 'kill' });
  }
  hints.push({ key: 'Esc', action: 'back' });
  return hints;
}

function metaLine(
  label: string,
  value: string | null | undefined,
): React.JSX.Element | null {
  if (!value) return null;
  return (
    <Box>
      <Box width={TASK_DETAIL_LABEL_WIDTH}>
        <Text bold>{label}:</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

interface TaskDetailLayout {
  readonly compact: boolean;
  readonly showCommand: boolean;
  readonly showExpandedMeta: boolean;
  readonly showHints: boolean;
  readonly showOutputLabel: boolean;
  readonly showTitle: boolean;
  readonly visibleLineCount: number;
}

export function taskDetailCommandLabel(kind: ChildControlItem['kind']): string {
  return kind === 'process' ? 'Command' : 'Description';
}

export function computeTaskDetailLayout({
  availableRows,
  hasTailLines,
  metaRows,
}: {
  readonly availableRows?: number;
  readonly hasTailLines: boolean;
  readonly metaRows: number;
}): TaskDetailLayout {
  const rows = Math.max(0, availableRows ?? 18);
  const showExpandedMeta = rows >= 16;
  const compact = !showExpandedMeta;
  const showHints = rows > ULTRA_COMPACT_TASK_DETAIL_MAX_ROWS;
  const showTitle = rows >= 9;
  const showOutputLabel = rows >= 10;
  const showCommand = rows >= 12;
  const renderedMetaRows = showExpandedMeta ? metaRows : 1;
  const gapRows = showExpandedMeta ? 2 : 0;
  const fixedRows =
    2 + // border
    (showTitle ? 1 : 0) +
    renderedMetaRows +
    (showCommand ? 1 : 0) +
    (showOutputLabel ? 1 : 0) +
    (showHints ? 1 : 0) +
    gapRows;
  const availableOutputRows = Math.max(0, rows - fixedRows);
  return {
    compact,
    showCommand,
    showExpandedMeta,
    showHints,
    showOutputLabel,
    showTitle,
    visibleLineCount:
      hasTailLines && rows >= fixedRows + 1
        ? Math.max(1, availableOutputRows)
        : availableOutputRows,
  };
}

function TaskOutput({
  childStreamId,
  tailLines,
  truncateTailRows = false,
  visibleTail,
  visibleLineCount,
}: {
  readonly childStreamId: StreamTabId | undefined;
  readonly tailLines: readonly string[];
  readonly truncateTailRows?: boolean;
  readonly visibleTail: readonly string[];
  readonly visibleLineCount: number;
}): React.JSX.Element | null {
  if (tailLines.length > 0) {
    if (visibleLineCount <= 0) return null;
    return (
      <>
        {visibleTail.map((line, index) => (
          <Text
            key={`${index}:${line}`}
            dimColor
            wrap={truncateTailRows ? 'truncate-end' : undefined}
          >
            {line}
          </Text>
        ))}
      </>
    );
  }
  if (visibleLineCount === 0) return null;
  if (childStreamId) {
    return (
      <Text dimColor>Open the task stream to see its live transcript.</Text>
    );
  }
  return <Text dimColor>No output captured yet.</Text>;
}

export function TaskDetailView({
  availableColumns,
  availableRows,
  item,
  onBack,
  onFocusStream,
  onKill,
}: {
  readonly availableColumns?: number;
  readonly availableRows?: number;
  readonly item: ChildControlItem;
  readonly onBack: () => void;
  readonly onFocusStream: () => void;
  readonly onKill: () => void;
}): React.JSX.Element {
  const metaParts = [
    item.kind === 'process' ? 'shell' : 'stream',
    item.label,
    item.statusLabel,
    item.elapsed,
  ].filter((part): part is string => Boolean(part));
  const layout = computeTaskDetailLayout({
    availableRows,
    hasTailLines: item.tailLines.length > 0,
    metaRows: metaParts.length,
  });
  const scrollableOutputRows = taskDetailScrollableOutputRowCountForColumns({
    availableColumns,
    compact: layout.compact,
    tailLines: item.tailLines,
  });
  const maxOffset = taskDetailInitialScrollOffset(
    scrollableOutputRows,
    layout.visibleLineCount,
  );
  const followOffset = taskDetailFollowTailScrollOffsetForColumns({
    availableColumns,
    compact: layout.compact,
    tailLines: item.tailLines,
    visibleRowBudget: layout.visibleLineCount,
  });
  const scrollContext: TaskDetailScrollContext = {
    availableColumns,
    compact: layout.compact,
    tailLines: item.tailLines,
  };
  const scrollContextKey = taskDetailScrollContextKey(scrollContext);
  const [scrollState, setScrollState] = useState<TaskDetailScrollState>(() => ({
    executionId: item.executionId,
    followsTail: true,
    offset: followOffset,
  }));
  const offset = taskDetailVisibleScrollOffset(
    scrollState,
    maxOffset,
    followOffset,
    scrollContext,
  );
  const visibleLineCount = layout.visibleLineCount;
  const visibleTail = taskDetailVisibleOutputRowsFromOffsetForColumns({
    availableColumns,
    compact: layout.compact,
    offset,
    tailLines: item.tailLines,
    visibleRowBudget: layout.visibleLineCount,
  });
  const truncateTailRows = layout.compact;
  const compactMeta = metaParts.join(' · ');
  const commandLabel = taskDetailCommandLabel(item.kind);
  const ultraCompact = isUltraCompactTaskDetailRows(availableRows);
  const showScrollHint = maxOffset > 0 && !ultraCompact;
  const hints = taskDetailKeyHintsForColumns({
    availableColumns,
    canFocusStream: Boolean(item.childStreamId),
    canKill: item.killable,
    showScrollHint,
  });

  useEffect(() => {
    setScrollState((current) =>
      syncTaskDetailScrollState(
        current,
        item.executionId,
        maxOffset,
        followOffset,
        scrollContext,
      ),
    );
  }, [item.executionId, followOffset, maxOffset, scrollContextKey]);

  useInput((input, key) => {
    const action = childPickerKeyAction({
      input,
      ctrl: key.ctrl,
      escape: key.escape,
      meta: key.meta,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
    });
    if (action.kind === 'close') onBack();
    if (action.kind === 'kill' && item.killable) onKill();
    if (action.kind === 'up') {
      setScrollState((current) =>
        moveTaskDetailScrollState(
          current,
          maxOffset,
          'up',
          followOffset,
          scrollContext,
        ),
      );
    }
    if (action.kind === 'down') {
      setScrollState((current) =>
        moveTaskDetailScrollState(
          current,
          maxOffset,
          'down',
          followOffset,
          scrollContext,
        ),
      );
    }
    if (key.pageUp) {
      setScrollState((current) =>
        pageTaskDetailScrollState(
          current,
          maxOffset,
          'up',
          visibleLineCount,
          followOffset,
          scrollContext,
        ),
      );
    }
    if (key.pageDown) {
      setScrollState((current) =>
        pageTaskDetailScrollState(
          current,
          maxOffset,
          'down',
          visibleLineCount,
          followOffset,
          scrollContext,
        ),
      );
    }
    if (isJumpToTopInput(input)) {
      setScrollState((current) =>
        jumpTaskDetailScrollState(
          current,
          maxOffset,
          'top',
          followOffset,
          scrollContext,
        ),
      );
    }
    if (isJumpToBottomInput(input)) {
      setScrollState((current) =>
        jumpTaskDetailScrollState(
          current,
          maxOffset,
          'bottom',
          followOffset,
          scrollContext,
        ),
      );
    }
    if (input.toLowerCase() === 'f' && item.childStreamId) onFocusStream();
  });

  if (ultraCompact) {
    return (
      <Box flexDirection="column" minWidth={0} width={availableColumns}>
        <Text bold color="cyan" wrap="truncate-end">
          {`Task details · ${commandLabel}: ${item.command}`}
        </Text>
        <KeyHints hints={hints} confirmCancel={false} />
      </Box>
    );
  }

  return (
    <BorderedPanel
      color="cyan"
      width={availableColumns}
      title={layout.showTitle ? 'Task details' : undefined}
      footer={
        layout.showHints ? (
          <KeyHints hints={hints} confirmCancel={false} />
        ) : undefined
      }
      footerMarginTop={layout.compact ? 0 : 1}
    >
      {layout.showExpandedMeta ? (
        <>
          {metaLine('Type', item.kind === 'process' ? 'shell' : 'stream')}
          {metaLine('Name', item.label)}
          {metaLine('Status', item.statusLabel)}
          {metaLine('Runtime', item.elapsed)}
        </>
      ) : (
        <Text
          bold={!layout.showTitle}
          color={!layout.showTitle ? 'cyan' : undefined}
          dimColor={layout.showTitle}
          wrap="truncate-end"
        >
          {compactMeta}
        </Text>
      )}
      {layout.showCommand ? (
        <Box marginTop={layout.compact ? 0 : 1}>
          <Box width={TASK_DETAIL_LABEL_WIDTH}>
            <Text bold>{`${commandLabel}:`}</Text>
          </Box>
          <Text wrap="truncate-end">{item.command}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={layout.compact ? 0 : 1}>
        {layout.showOutputLabel ? <Text bold>Output:</Text> : null}
        <TaskOutput
          childStreamId={item.childStreamId}
          tailLines={item.tailLines}
          truncateTailRows={truncateTailRows}
          visibleTail={visibleTail}
          visibleLineCount={visibleLineCount}
        />
      </Box>
    </BorderedPanel>
  );
}
