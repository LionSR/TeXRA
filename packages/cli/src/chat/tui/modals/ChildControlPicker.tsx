// Child execution picker for the CLI TUI.

// Third-party imports
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';

import { Box, Text, useInput } from 'ink';

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

// Local imports - CLI state and UI
import { clamp, clampIndex } from '@utils/core';

import {
  CHILD_CONTROL_MODE_COPY,
  buildChildControlItems,
  childPickerKeyAction,
  liveChildExecutionElapsedKey,
  nextPickerIndex,
  subagentPickerSelection,
  type ChildControlItem,
  type ChildControlMode,
} from '../state/childControls';
import { useLiveNowMs } from '../state/useLiveNowMs';
import {
  syncTaskDetailScrollState,
  taskDetailFollowTailScrollOffsetForColumns,
  taskDetailInitialScrollOffset,
  taskDetailScrollableOutputRowCountForColumns,
  taskDetailScrollContextKey,
  taskDetailVisibleOutputRowsFromOffsetForColumns,
  taskDetailVisibleScrollOffset,
  moveTaskDetailScrollState,
  type TaskDetailScrollContext,
  type TaskDetailScrollState,
} from '../state/taskDetailScroll';
import { textDisplayWidth } from '../render/terminalText';
import { KEY_HINT_SEPARATOR, KeyHints, type KeyHint } from '../ui/KeyHints';
import { POINTER } from '../ui/glyphs';
import { SELECT_LABEL_MAX_COLS } from '../ui/Select';
import type { StreamSlice } from '../state/cliState/types';

interface ChildControlPickerProps {
  readonly availableColumns?: number;
  readonly streamLabel: string | undefined;
  readonly activeStreamId: StreamTabId | undefined;
  readonly availableRows?: number;
  readonly mode: ChildControlMode;
  readonly onClose: () => void;
  readonly onEscapeActionChange?: (action: string) => void;
  readonly onFocusStream: (streamId: StreamTabId) => void;
  /** Open the chosen subagent's transcript viewer (its independent history).
   *  Falls back to focus when omitted. */
  readonly onViewStream?: (streamId: StreamTabId) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly slice: StreamSlice | undefined;
  readonly streamScopeDetail?: string;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}

export const TASK_DETAIL_LABEL_WIDTH = 13;
const ULTRA_COMPACT_PICKER_MAX_ROWS = 6;
const ULTRA_COMPACT_TASK_DETAIL_MAX_ROWS = 4;
const NARROW_TASK_DETAIL_HINT_MAX_COLUMNS = 56;
const PICKER_HORIZONTAL_CHROME_COLUMNS = 4;
const MIN_COLUMNS_FOR_KILL_HINT = 44;

export function pickerTitle(mode: ChildControlMode): string {
  return CHILD_CONTROL_MODE_COPY[mode].title;
}

export function emptyPickerText(mode: ChildControlMode): string {
  return CHILD_CONTROL_MODE_COPY[mode].emptyText;
}

export function isUltraCompactPickerRows(
  availableRows: number | undefined,
): boolean {
  return (
    availableRows !== undefined &&
    availableRows <= ULTRA_COMPACT_PICKER_MAX_ROWS
  );
}

export function isUltraCompactTaskDetailRows(
  availableRows: number | undefined,
): boolean {
  return (
    availableRows !== undefined &&
    availableRows <= ULTRA_COMPACT_TASK_DETAIL_MAX_ROWS
  );
}

export function pickerKeyHints(
  mode: ChildControlMode,
  itemCount: number,
  canKill = itemCount > 0,
): readonly KeyHint[] {
  return pickerKeyHintsForColumns(mode, itemCount, canKill);
}

function keyHintDisplayText(hint: KeyHint): string {
  return `${hint.key} ${hint.action}`;
}

function keyHintsDisplayWidth(hints: readonly KeyHint[]): number {
  return textDisplayWidth(
    hints.map(keyHintDisplayText).join(KEY_HINT_SEPARATOR),
  );
}

function keyHintsFit(
  hints: readonly KeyHint[],
  availableColumns: number | undefined,
): boolean {
  return (
    availableColumns === undefined ||
    keyHintsDisplayWidth(hints) <= availableColumns
  );
}

type PickerOptionalHint = 'focus' | 'jump' | 'kill';

function pickerHintsForOptionals(
  mode: ChildControlMode,
  itemCount: number,
  canKill: boolean,
  selected: ReadonlySet<PickerOptionalHint>,
  availableColumns: number | undefined,
): readonly KeyHint[] {
  return [
    {
      key: '↑/↓',
      action: availableColumns === undefined ? 'navigate' : 'nav',
    },
    ...(selected.has('jump') && itemCount > 1
      ? [{ key: '1-9', action: 'jump' }]
      : []),
    { key: 'Enter', action: 'view' },
    ...(selected.has('focus') && mode === 'subagents'
      ? [{ key: 'f', action: 'focus' }]
      : []),
    ...(selected.has('kill') && canKill ? [{ key: 'k', action: 'kill' }] : []),
    { key: 'Esc', action: 'close' },
  ];
}

export function pickerKeyHintsForColumns(
  mode: ChildControlMode,
  itemCount: number,
  canKill = itemCount > 0,
  availableColumns?: number,
): readonly KeyHint[] {
  if (itemCount <= 0) return [{ key: 'Esc', action: 'close' }];

  const selected = new Set<PickerOptionalHint>();
  const priority: readonly PickerOptionalHint[] =
    mode === 'subagents' ? ['focus', 'jump', 'kill'] : ['kill', 'jump'];

  for (const option of priority) {
    const nextSelected = new Set(selected);
    nextSelected.add(option);
    const nextHints = pickerHintsForOptionals(
      mode,
      itemCount,
      canKill,
      nextSelected,
      availableColumns,
    );
    if (keyHintsFit(nextHints, availableColumns)) selected.add(option);
  }

  return pickerHintsForOptionals(
    mode,
    itemCount,
    canKill,
    selected,
    availableColumns,
  );
}

function framedPickerHintColumns(
  availableColumns: number | undefined,
): number | undefined {
  return availableColumns === undefined
    ? undefined
    : Math.max(0, availableColumns - PICKER_HORIZONTAL_CHROME_COLUMNS);
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

function PickerItemHead({
  highlighted,
  index,
  label,
}: {
  readonly highlighted: boolean;
  readonly index: number;
  readonly label: string;
}): React.JSX.Element {
  const color = highlighted ? 'cyan' : undefined;
  return (
    <>
      <Box flexShrink={0}>
        <Text color={color}>
          {highlighted ? POINTER : ' '} {index + 1}.{' '}
        </Text>
      </Box>
      <Box flexShrink={0} maxWidth={SELECT_LABEL_MAX_COLS}>
        <Text color={color} wrap="truncate-end">
          {label}
        </Text>
      </Box>
    </>
  );
}

function renderItem(
  item: ChildControlItem,
  index: number,
  highlighted: boolean,
  stackedDetail = false,
): React.JSX.Element {
  const commandDetail = item.command !== item.label ? item.command : '';
  if (stackedDetail) {
    return (
      <Box key={item.executionId} flexDirection="column" minWidth={0}>
        <Box minWidth={0}>
          <PickerItemHead
            highlighted={highlighted}
            index={index}
            label={item.label}
          />
          {item.description ? (
            <Text dimColor wrap="truncate-end">{` — ${item.description}`}</Text>
          ) : null}
        </Box>
        {commandDetail ? (
          <Box marginLeft={4} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              {commandDetail}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  const detail = [item.description, commandDetail].filter(Boolean).join(' — ');
  return (
    <Box key={item.executionId} minWidth={0}>
      <PickerItemHead
        highlighted={highlighted}
        index={index}
        label={item.label}
      />
      {detail ? (
        <Text dimColor wrap="truncate-end">{` — ${detail}`}</Text>
      ) : null}
    </Box>
  );
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

interface PickerListLayout {
  readonly end: number;
  readonly hiddenAfter: number;
  readonly hiddenBefore: number;
  readonly start: number;
  readonly visibleCount: number;
}

export function compactPickerOverflowText({
  itemCount,
  selectedIndex,
}: {
  readonly itemCount: number;
  readonly selectedIndex: number;
}): string | undefined {
  if (itemCount <= 1) return undefined;

  const earlier = Math.max(0, selectedIndex);
  const more = Math.max(0, itemCount - selectedIndex - 1);
  if (earlier > 0 && more > 0) return `+${earlier} earlier, +${more} more`;
  if (earlier > 0) return `+${earlier} earlier`;
  return `+${more} more`;
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

export function computePickerListLayout({
  availableRows,
  extraListRowCount = 0,
  highlight,
  hintsMarginRows = 1,
  itemCount,
  listMarginRows = 1,
  scopeLineCount,
}: {
  readonly availableRows?: number;
  readonly extraListRowCount?: number;
  readonly highlight: number;
  readonly hintsMarginRows?: number;
  readonly itemCount: number;
  readonly listMarginRows?: number;
  readonly scopeLineCount: number;
}): PickerListLayout {
  const rows = Math.max(0, availableRows ?? 18);
  const fixedRows =
    2 + // border
    1 + // title
    Math.max(0, scopeLineCount) +
    Math.max(0, listMarginRows) +
    Math.max(0, extraListRowCount) +
    Math.max(0, hintsMarginRows) +
    1; // hints row
  const rowBudget = Math.max(1, rows - fixedRows);
  const windowStart = (count: number): number => {
    const lastStart = Math.max(0, itemCount - count);
    return clamp(highlight - Math.floor(count / 2), 0, lastStart);
  };
  let visibleCount = Math.min(itemCount, rowBudget);
  for (let i = 0; i < 2; i += 1) {
    const start = windowStart(visibleCount);
    const end = start + visibleCount;
    const markerRows =
      rowBudget >= 3 ? (start > 0 ? 1 : 0) + (end < itemCount ? 1 : 0) : 0;
    visibleCount =
      itemCount === 0 ? 0 : clamp(rowBudget - markerRows, 1, itemCount);
  }
  const start = windowStart(visibleCount);
  const end = start + visibleCount;
  const markerRowsAllowed = rowBudget >= visibleCount + 1;
  return {
    end,
    hiddenAfter: markerRowsAllowed ? Math.max(0, itemCount - end) : 0,
    hiddenBefore: markerRowsAllowed ? start : 0,
    start,
    visibleCount,
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

function TaskDetailView({
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
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
      width={availableColumns}
    >
      {layout.showTitle ? (
        <Text bold color="cyan">
          Task details
        </Text>
      ) : null}
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
      {layout.showHints ? (
        <Box marginTop={layout.compact ? 0 : 1}>
          <KeyHints hints={hints} confirmCancel={false} />
        </Box>
      ) : null}
    </Box>
  );
}

export function ChildControlPicker({
  availableColumns,
  streamLabel,
  activeStreamId,
  availableRows,
  mode,
  onClose,
  onEscapeActionChange,
  onFocusStream,
  onViewStream,
  onKillExecution,
  slice,
  streamScopeDetail,
  streams,
}: ChildControlPickerProps): React.JSX.Element {
  const liveElapsedKey = liveChildExecutionElapsedKey(slice);
  const nowMs = useLiveNowMs(liveElapsedKey !== undefined, liveElapsedKey);
  const items = useMemo(
    () => (slice ? buildChildControlItems(slice, mode, streams, nowMs) : []),
    [mode, nowMs, slice, streams],
  );
  const [highlight, setHighlight] = useState(0);
  const [tailExecutionId, setTailExecutionId] = useState<string | undefined>(
    undefined,
  );
  const streamScopeLabel = streamLabel ?? activeStreamId;
  const selectedIndex = clampIndex(highlight, items.length);
  const selectedItem = items[selectedIndex];
  const hasItems = items.length > 0;
  const tailItem = tailExecutionId
    ? items.find((item) => item.executionId === tailExecutionId)
    : undefined;
  const escapeAction = tailItem ? 'back' : 'close';
  const stackSelectedSubagent = mode === 'subagents' && hasItems;
  const compactEmptyPicker = !hasItems;
  const listLayout = computePickerListLayout({
    availableRows,
    extraListRowCount: stackSelectedSubagent ? 1 : 0,
    highlight: selectedIndex,
    hintsMarginRows: stackSelectedSubagent || compactEmptyPicker ? 0 : 1,
    itemCount: items.length,
    listMarginRows: stackSelectedSubagent || compactEmptyPicker ? 0 : 1,
    scopeLineCount: streamScopeLabel !== undefined ? 1 : 0,
  });
  const visibleItems = items.slice(listLayout.start, listLayout.end);
  const streamScopeText = streamScopeLabel
    ? `Stream: ${streamScopeLabel}${
        streamScopeDetail ? ` (${streamScopeDetail})` : ''
      }`
    : undefined;
  const compactOverflowText = compactPickerOverflowText({
    itemCount: items.length,
    selectedIndex,
  });
  const ultraCompact = isUltraCompactPickerRows(availableRows);
  const hintColumns = ultraCompact
    ? availableColumns
    : framedPickerHintColumns(availableColumns);

  useEffect(() => {
    setHighlight((current) => clampIndex(current, items.length));
  }, [items.length]);

  useEffect(() => {
    if (tailExecutionId && !tailItem) setTailExecutionId(undefined);
  }, [tailExecutionId, tailItem]);

  useLayoutEffect(() => {
    onEscapeActionChange?.(escapeAction);
  }, [escapeAction, onEscapeActionChange]);

  useInput(
    (input, key) => {
      // 'f' focuses the highlighted subagent (make it the active stream)
      // without opening its transcript — distinct from Enter, which opens
      // the scoped viewer. Mirrors TaskDetailView's 'f: focus stream'.
      if (
        mode === 'subagents' &&
        input.toLowerCase() === 'f' &&
        selectedItem?.childStreamId
      ) {
        onFocusStream(selectedItem.childStreamId);
        onClose();
        return;
      }
      const action = childPickerKeyAction({
        input,
        ctrl: key.ctrl,
        escape: key.escape,
        meta: key.meta,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        return: key.return,
      });
      switch (action.kind) {
        case 'close':
          onClose();
          return;
        case 'up':
          setHighlight((current) =>
            nextPickerIndex(current, items.length, 'up'),
          );
          return;
        case 'down':
          setHighlight((current) =>
            nextPickerIndex(current, items.length, 'down'),
          );
          return;
        case 'jump':
          if (action.index < items.length) setHighlight(action.index);
          return;
        case 'select': {
          const selection = subagentPickerSelection(mode, selectedItem);
          if (!selection) return;
          if (selection.kind === 'view') {
            (onViewStream ?? onFocusStream)(selection.streamId);
            onClose();
            return;
          }
          setTailExecutionId(selection.executionId);
          return;
        }
        case 'kill': {
          if (!selectedItem?.killable) return;
          onKillExecution(selectedItem.executionId);
          onClose();
          return;
        }
        case 'ignore':
          return;
      }
    },
    { isActive: tailExecutionId === undefined },
  );

  if (tailItem) {
    return (
      <TaskDetailView
        availableColumns={availableColumns}
        availableRows={availableRows}
        item={tailItem}
        onBack={() => setTailExecutionId(undefined)}
        onFocusStream={() => {
          if (!tailItem.childStreamId) return;
          onFocusStream(tailItem.childStreamId);
          onClose();
        }}
        onKill={() => {
          onKillExecution(tailItem.executionId);
          onClose();
        }}
      />
    );
  }

  if (ultraCompact) {
    const titleParts = [
      pickerTitle(mode),
      streamScopeText,
      compactOverflowText,
    ].filter((part): part is string => Boolean(part));
    return (
      <Box flexDirection="column" minWidth={0} width={availableColumns}>
        <Text bold color="cyan" wrap="truncate-end">
          {titleParts.join(' · ')}
        </Text>
        {selectedItem ? (
          renderItem(selectedItem, selectedIndex, true)
        ) : (
          <Text dimColor>{emptyPickerText(mode)}</Text>
        )}
        <KeyHints
          hints={pickerKeyHintsForColumns(
            mode,
            items.length,
            selectedItem?.killable ?? false,
            hintColumns,
          )}
          confirmCancel={false}
        />
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
      width={availableColumns}
    >
      <Text bold color="cyan">
        {pickerTitle(mode)}
      </Text>
      {streamScopeText ? (
        <Text dimColor wrap="truncate-end">
          {streamScopeText}
        </Text>
      ) : null}
      <Box
        flexDirection="column"
        marginTop={stackSelectedSubagent || compactEmptyPicker ? 0 : 1}
      >
        {hasItems ? (
          <>
            {listLayout.hiddenBefore > 0 ? (
              <Text dimColor>{`... ${listLayout.hiddenBefore} earlier`}</Text>
            ) : null}
            {visibleItems.map((item, offset) => {
              const index = listLayout.start + offset;
              return renderItem(
                item,
                index,
                index === selectedIndex,
                stackSelectedSubagent && index === selectedIndex,
              );
            })}
            {listLayout.hiddenAfter > 0 ? (
              <Text dimColor>{`... ${listLayout.hiddenAfter} more`}</Text>
            ) : null}
          </>
        ) : (
          <Text dimColor>{emptyPickerText(mode)}</Text>
        )}
      </Box>
      <Box marginTop={stackSelectedSubagent || compactEmptyPicker ? 0 : 1}>
        <KeyHints
          hints={pickerKeyHintsForColumns(
            mode,
            items.length,
            selectedItem?.killable ?? false,
            hintColumns,
          )}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
