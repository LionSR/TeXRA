// Child execution picker for the CLI TUI.

// Third-party imports
import { useEffect, useMemo, useState } from 'react';

import { Box, Text, useInput } from 'ink';

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

// Local imports - CLI state and UI
import {
  buildChildControlItems,
  childPickerKeyAction,
  clampPickerIndex,
  liveChildExecutionElapsedKey,
  nextPickerIndex,
  type ChildControlItem,
  type ChildControlMode,
} from '../state/childControls';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { KeyHints, type KeyHint } from '../ui/KeyHints';
import { SELECT_LABEL_MAX_COLS } from '../ui/Select';
import type { StreamSlice } from '../state/cliState';

export interface ChildControlPickerProps {
  readonly availableColumns?: number;
  readonly activeStreamLabel: string | undefined;
  readonly activeStreamId: StreamTabId | undefined;
  readonly availableRows?: number;
  readonly mode: ChildControlMode;
  readonly onClose: () => void;
  readonly onFocusStream: (streamId: StreamTabId) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly slice: StreamSlice | undefined;
  readonly streamScopeDetail?: string;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}

export const TASK_DETAIL_LABEL_WIDTH = 13;
export const ULTRA_COMPACT_PICKER_MAX_ROWS = 4;
export const NARROW_PICKER_HINT_MAX_COLUMNS = 64;
export const MIN_COLUMNS_FOR_JUMP_HINT = 58;
export const MIN_COLUMNS_FOR_KILL_HINT = 44;

export function pickerTitle(mode: ChildControlMode): string {
  return mode === 'subagents' ? 'Subagents' : 'Tasks and sub-workflows';
}

export function emptyPickerText(mode: ChildControlMode): string {
  return mode === 'subagents'
    ? 'No active subagents.'
    : 'No active tasks or sub-workflows.';
}

export function isUltraCompactPickerRows(
  availableRows: number | undefined,
): boolean {
  return (
    availableRows !== undefined &&
    availableRows <= ULTRA_COMPACT_PICKER_MAX_ROWS
  );
}

export function pickerKeyHints(
  mode: ChildControlMode,
  itemCount: number,
  canKill = itemCount > 0,
): readonly KeyHint[] {
  if (itemCount <= 0) {
    return [{ key: 'Esc', action: 'close' }];
  }
  const hints: KeyHint[] = [{ key: '↑/↓', action: 'navigate' }];
  if (itemCount > 1) hints.push({ key: '1-9', action: 'jump' });
  hints.push({ key: 'Enter', action: mode === 'subagents' ? 'focus' : 'view' });
  if (canKill) hints.push({ key: 'k', action: 'kill' });
  hints.push({ key: 'Esc', action: 'close' });
  return hints;
}

export function pickerKeyHintsForColumns(
  mode: ChildControlMode,
  itemCount: number,
  canKill = itemCount > 0,
  availableColumns?: number,
): readonly KeyHint[] {
  if (
    availableColumns === undefined ||
    availableColumns > NARROW_PICKER_HINT_MAX_COLUMNS ||
    itemCount <= 0
  ) {
    return pickerKeyHints(mode, itemCount, canKill);
  }

  const hints: KeyHint[] = [{ key: '↑/↓', action: 'nav' }];
  if (itemCount > 1 && availableColumns >= MIN_COLUMNS_FOR_JUMP_HINT) {
    hints.push({ key: '1-9', action: 'jump' });
  }
  hints.push({ key: 'Enter', action: mode === 'subagents' ? 'focus' : 'view' });
  if (canKill && availableColumns >= MIN_COLUMNS_FOR_KILL_HINT) {
    hints.push({ key: 'k', action: 'kill' });
  }
  hints.push({ key: 'Esc', action: 'close' });
  return hints;
}

function renderItem(
  item: ChildControlItem,
  index: number,
  highlighted: boolean,
): React.JSX.Element {
  const detail = [
    item.description,
    item.command !== item.label ? item.command : '',
  ]
    .filter(Boolean)
    .join(' — ');
  return (
    <Box key={item.executionId} minWidth={0}>
      <Box flexShrink={0}>
        <Text color={highlighted ? 'cyan' : undefined}>
          {highlighted ? '›' : ' '} {index + 1}.{' '}
        </Text>
      </Box>
      <Box flexShrink={0} maxWidth={SELECT_LABEL_MAX_COLS}>
        <Text color={highlighted ? 'cyan' : undefined} wrap="truncate-end">
          {item.label}
        </Text>
      </Box>
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

export interface TaskDetailLayout {
  readonly compact: boolean;
  readonly showCommand: boolean;
  readonly showExpandedMeta: boolean;
  readonly showHints: boolean;
  readonly visibleLineCount: number;
}

export interface PickerListLayout {
  readonly end: number;
  readonly hiddenAfter: number;
  readonly hiddenBefore: number;
  readonly start: number;
  readonly visibleCount: number;
}

export interface TaskDetailScrollState {
  readonly executionId: string;
  readonly followsTail: boolean;
  readonly offset: number;
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
  const showCommand = rows >= 10;
  const showHints = rows >= 7;
  const renderedMetaRows = showExpandedMeta ? metaRows : 1;
  const gapRows = showExpandedMeta ? 2 : 0;
  const fixedRows =
    2 + // border
    1 + // title
    renderedMetaRows +
    (showCommand ? 1 : 0) +
    1 + // output label
    (showHints ? 1 : 0) +
    gapRows;
  const availableOutputRows = Math.max(0, rows - fixedRows);
  return {
    compact,
    showCommand,
    showExpandedMeta,
    showHints,
    visibleLineCount:
      hasTailLines && rows >= fixedRows + 1
        ? Math.max(1, availableOutputRows)
        : availableOutputRows,
  };
}

export function taskDetailInitialScrollOffset(
  tailLineCount: number,
  visibleLineCount: number,
): number {
  return Math.max(0, tailLineCount - Math.max(0, visibleLineCount));
}

export function syncTaskDetailScrollState(
  state: TaskDetailScrollState,
  executionId: string,
  maxOffset: number,
): TaskDetailScrollState {
  if (state.executionId !== executionId) {
    return { executionId, followsTail: true, offset: maxOffset };
  }
  if (state.followsTail) {
    return { ...state, offset: maxOffset };
  }
  return { ...state, offset: Math.min(state.offset, maxOffset) };
}

export function taskDetailVisibleScrollOffset(
  state: TaskDetailScrollState,
  maxOffset: number,
): number {
  if (state.followsTail) return maxOffset;
  return Math.min(state.offset, maxOffset);
}

export function moveTaskDetailScrollState(
  state: TaskDetailScrollState,
  maxOffset: number,
  direction: 'down' | 'up',
): TaskDetailScrollState {
  const offset = taskDetailVisibleScrollOffset(state, maxOffset);
  if (direction === 'up') {
    return {
      ...state,
      followsTail: false,
      offset: Math.max(0, offset - 1),
    };
  }
  const nextOffset = Math.min(maxOffset, offset + 1);
  return {
    ...state,
    followsTail: nextOffset >= maxOffset,
    offset: nextOffset,
  };
}

export function computePickerListLayout({
  availableRows,
  highlight,
  itemCount,
  scopeLineCount,
}: {
  readonly availableRows?: number;
  readonly highlight: number;
  readonly itemCount: number;
  readonly scopeLineCount: number;
}): PickerListLayout {
  const rows = Math.max(0, availableRows ?? 18);
  const fixedRows =
    2 + // border
    1 + // title
    Math.max(0, scopeLineCount) +
    1 + // list top margin
    2; // hints margin + row
  const rowBudget = Math.max(1, rows - fixedRows);
  const windowStart = (count: number): number => {
    const lastStart = Math.max(0, itemCount - count);
    return Math.min(lastStart, Math.max(0, highlight - Math.floor(count / 2)));
  };
  let visibleCount = Math.min(itemCount, rowBudget);
  for (let i = 0; i < 2; i += 1) {
    const start = windowStart(visibleCount);
    const end = start + visibleCount;
    const markerRows =
      rowBudget >= 3 ? (start > 0 ? 1 : 0) + (end < itemCount ? 1 : 0) : 0;
    visibleCount = Math.min(itemCount, Math.max(1, rowBudget - markerRows));
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
  visibleTail,
  visibleLineCount,
}: {
  readonly childStreamId: StreamTabId | undefined;
  readonly tailLines: readonly string[];
  readonly visibleTail: readonly string[];
  readonly visibleLineCount: number;
}): React.JSX.Element | null {
  if (tailLines.length > 0) {
    if (visibleLineCount <= 0) return null;
    return (
      <>
        {visibleTail.map((line, index) => (
          <Text key={`${index}:${line}`} dimColor>
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
    item.status,
    item.elapsed,
  ].filter((part): part is string => Boolean(part));
  const layout = computeTaskDetailLayout({
    availableRows,
    hasTailLines: item.tailLines.length > 0,
    metaRows: metaParts.length,
  });
  const visibleLineCount = layout.visibleLineCount;
  const maxOffset = taskDetailInitialScrollOffset(
    item.tailLines.length,
    visibleLineCount,
  );
  const [scrollState, setScrollState] = useState<TaskDetailScrollState>(() => ({
    executionId: item.executionId,
    followsTail: true,
    offset: maxOffset,
  }));
  const offset = taskDetailVisibleScrollOffset(scrollState, maxOffset);
  const visibleTail = item.tailLines.slice(offset, offset + visibleLineCount);
  const compactMeta = metaParts.join(' · ');
  const commandLabel = taskDetailCommandLabel(item.kind);

  useEffect(() => {
    setScrollState((current) =>
      syncTaskDetailScrollState(current, item.executionId, maxOffset),
    );
  }, [item.executionId, maxOffset]);

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
        moveTaskDetailScrollState(current, maxOffset, 'up'),
      );
    }
    if (action.kind === 'down') {
      setScrollState((current) =>
        moveTaskDetailScrollState(current, maxOffset, 'down'),
      );
    }
    if (input.toLowerCase() === 'f' && item.childStreamId) onFocusStream();
  });

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
      width={availableColumns}
    >
      <Text bold color="cyan">
        Task details
      </Text>
      {layout.showExpandedMeta ? (
        <>
          {metaLine('Type', item.kind === 'process' ? 'shell' : 'stream')}
          {metaLine('Name', item.label)}
          {metaLine('Status', item.status)}
          {metaLine('Runtime', item.elapsed)}
        </>
      ) : (
        <Text dimColor wrap="truncate-end">
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
        <Text bold>Output:</Text>
        <TaskOutput
          childStreamId={item.childStreamId}
          tailLines={item.tailLines}
          visibleTail={visibleTail}
          visibleLineCount={visibleLineCount}
        />
      </Box>
      {layout.showHints ? (
        <Box marginTop={layout.compact ? 0 : 1}>
          <KeyHints
            hints={[
              ...(item.tailLines.length > visibleLineCount
                ? [{ key: '↑/↓', action: 'scroll' }]
                : []),
              ...(item.childStreamId
                ? [{ key: 'f', action: 'focus stream' }]
                : []),
              ...(item.killable ? [{ key: 'k', action: 'kill' }] : []),
              { key: 'Esc', action: 'back' },
            ]}
            confirmCancel={false}
          />
        </Box>
      ) : null}
    </Box>
  );
}

export function ChildControlPicker({
  availableColumns,
  activeStreamLabel,
  activeStreamId,
  availableRows,
  mode,
  onClose,
  onFocusStream,
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
  const streamScopeLabel = activeStreamLabel ?? activeStreamId;
  const selectedIndex = clampPickerIndex(highlight, items.length);
  const selectedItem = items[selectedIndex];
  const tailItem = tailExecutionId
    ? items.find((item) => item.executionId === tailExecutionId)
    : undefined;
  const listLayout = computePickerListLayout({
    availableRows,
    highlight: selectedIndex,
    itemCount: items.length,
    scopeLineCount: streamScopeLabel !== undefined ? 1 : 0,
  });
  const visibleItems = items.slice(listLayout.start, listLayout.end);
  const streamScopeText = streamScopeLabel
    ? `Stream: ${streamScopeLabel}${
        streamScopeDetail ? ` (${streamScopeDetail})` : ''
      }`
    : undefined;

  useEffect(() => {
    setHighlight((current) => clampPickerIndex(current, items.length));
  }, [items.length]);

  useEffect(() => {
    if (tailExecutionId && !tailItem) setTailExecutionId(undefined);
  }, [tailExecutionId, tailItem]);

  useInput(
    (input, key) => {
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
          if (!selectedItem) return;
          if (mode === 'subagents' && selectedItem.childStreamId) {
            onFocusStream(selectedItem.childStreamId);
            onClose();
            return;
          }
          setTailExecutionId(selectedItem.executionId);
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

  if (isUltraCompactPickerRows(availableRows)) {
    return (
      <Box flexDirection="column" minWidth={0} width={availableColumns}>
        <Text bold color="cyan" wrap="truncate-end">
          {streamScopeText
            ? `${pickerTitle(mode)} · ${streamScopeText}`
            : pickerTitle(mode)}
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
            availableColumns,
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
      <Box flexDirection="column" marginTop={1}>
        {items.length > 0 ? (
          <>
            {listLayout.hiddenBefore > 0 ? (
              <Text dimColor>{`... ${listLayout.hiddenBefore} earlier`}</Text>
            ) : null}
            {visibleItems.map((item, offset) => {
              const index = listLayout.start + offset;
              return renderItem(item, index, index === selectedIndex);
            })}
            {listLayout.hiddenAfter > 0 ? (
              <Text dimColor>{`... ${listLayout.hiddenAfter} more`}</Text>
            ) : null}
          </>
        ) : (
          <Text dimColor>{emptyPickerText(mode)}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={pickerKeyHintsForColumns(
            mode,
            items.length,
            selectedItem?.killable ?? false,
            availableColumns,
          )}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
