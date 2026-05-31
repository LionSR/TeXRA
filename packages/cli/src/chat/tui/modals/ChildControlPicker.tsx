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
import { wrapAnsiToWidth } from '../render/ansiWrap';
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
export const ULTRA_COMPACT_PICKER_MAX_ROWS = 6;
export const ULTRA_COMPACT_TASK_DETAIL_MAX_ROWS = 4;
export const NARROW_PICKER_HINT_MAX_COLUMNS = 64;
export const NARROW_TASK_DETAIL_HINT_MAX_COLUMNS = 48;
export const TASK_DETAIL_HORIZONTAL_CHROME_COLUMNS = 4;
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

export function taskDetailOutputColumnCount(
  availableColumns: number | undefined,
): number | undefined {
  return availableColumns === undefined
    ? undefined
    : Math.max(1, availableColumns - TASK_DETAIL_HORIZONTAL_CHROME_COLUMNS);
}

export function taskDetailWrappedRowCount(
  line: string,
  outputColumns: number | undefined,
): number {
  if (outputColumns === undefined) return 1;
  return Math.max(1, wrapAnsiToWidth(line, outputColumns).split('\n').length);
}

export function taskDetailVisibleLineCountForColumns({
  availableColumns,
  compact,
  tailLines,
  visibleRowBudget,
}: {
  readonly availableColumns?: number;
  readonly compact: boolean;
  readonly tailLines: readonly string[];
  readonly visibleRowBudget: number;
}): number {
  if (visibleRowBudget <= 0) return 0;
  if (!compact || tailLines.length === 0) return visibleRowBudget;

  const outputColumns = taskDetailOutputColumnCount(availableColumns);
  if (outputColumns === undefined) return visibleRowBudget;

  let usedRows = 0;
  let visibleLines = 0;
  for (let index = tailLines.length - 1; index >= 0; index -= 1) {
    const rowCount = taskDetailWrappedRowCount(tailLines[index], outputColumns);
    if (visibleLines > 0 && usedRows + rowCount > visibleRowBudget) break;
    visibleLines += 1;
    usedRows += rowCount;
    if (usedRows >= visibleRowBudget) break;
  }
  return Math.max(1, visibleLines);
}

export function taskDetailVisibleLineCountFromOffsetForColumns({
  availableColumns,
  compact,
  tailLines,
  visibleRowBudget,
  offset,
}: {
  readonly availableColumns?: number;
  readonly compact: boolean;
  readonly tailLines: readonly string[];
  readonly visibleRowBudget: number;
  readonly offset: number;
}): number {
  if (visibleRowBudget <= 0) return 0;
  if (!compact || tailLines.length === 0) return visibleRowBudget;

  const outputColumns = taskDetailOutputColumnCount(availableColumns);
  if (outputColumns === undefined) return visibleRowBudget;

  const start = Math.min(Math.max(0, offset), tailLines.length - 1);
  let usedRows = 0;
  let visibleLines = 0;
  for (let index = start; index < tailLines.length; index += 1) {
    const rowCount = taskDetailWrappedRowCount(tailLines[index], outputColumns);
    if (visibleLines > 0 && usedRows + rowCount > visibleRowBudget) break;
    visibleLines += 1;
    usedRows += rowCount;
    if (usedRows >= visibleRowBudget) break;
  }
  return Math.max(1, visibleLines);
}

export function taskDetailScrollableOutputRowCountForColumns({
  availableColumns,
  compact,
  tailLines,
}: {
  readonly availableColumns?: number;
  readonly compact: boolean;
  readonly tailLines: readonly string[];
}): number {
  if (!compact) return tailLines.length;

  const outputColumns = taskDetailOutputColumnCount(availableColumns);
  if (outputColumns === undefined) return tailLines.length;

  return tailLines.reduce(
    (total, line) => total + taskDetailWrappedRowCount(line, outputColumns),
    0,
  );
}

export function taskDetailFollowTailScrollOffsetForColumns({
  availableColumns,
  compact,
  tailLines,
  visibleRowBudget,
}: {
  readonly availableColumns?: number;
  readonly compact: boolean;
  readonly tailLines: readonly string[];
  readonly visibleRowBudget: number;
}): number {
  const scrollableRows = taskDetailScrollableOutputRowCountForColumns({
    availableColumns,
    compact,
    tailLines,
  });
  const maxOffset = taskDetailInitialScrollOffset(
    scrollableRows,
    visibleRowBudget,
  );
  if (!compact || visibleRowBudget <= 0 || tailLines.length === 0) {
    return maxOffset;
  }

  const outputColumns = taskDetailOutputColumnCount(availableColumns);
  if (outputColumns === undefined) return maxOffset;

  const visibleLineCount = taskDetailVisibleLineCountForColumns({
    availableColumns,
    compact,
    tailLines,
    visibleRowBudget,
  });
  const firstTailLine = Math.max(0, tailLines.length - visibleLineCount);
  let offset = 0;
  for (let index = 0; index < firstTailLine; index += 1) {
    offset += taskDetailWrappedRowCount(tailLines[index], outputColumns);
  }
  return Math.min(offset, maxOffset);
}

export function taskDetailVisibleOutputRowsFromOffsetForColumns({
  availableColumns,
  compact,
  offset,
  tailLines,
  visibleRowBudget,
}: {
  readonly availableColumns?: number;
  readonly compact: boolean;
  readonly offset: number;
  readonly tailLines: readonly string[];
  readonly visibleRowBudget: number;
}): readonly string[] {
  if (visibleRowBudget <= 0) return [];
  if (!compact) return tailLines.slice(offset, offset + visibleRowBudget);

  const outputColumns = taskDetailOutputColumnCount(availableColumns);
  const start = Math.max(0, offset);
  if (outputColumns === undefined) {
    return tailLines.slice(start, start + visibleRowBudget);
  }

  const rows: string[] = [];
  for (let index = 0; index < tailLines.length; index += 1) {
    const wrappedRows = wrapAnsiToWidth(tailLines[index], outputColumns).split(
      '\n',
    );
    rows.push(...wrappedRows);
  }
  return rows.slice(start, start + visibleRowBudget);
}

function renderItem(
  item: ChildControlItem,
  index: number,
  highlighted: boolean,
  extraDetail?: string,
  stackedDetail = false,
): React.JSX.Element {
  const commandDetail = item.command !== item.label ? item.command : '';
  if (stackedDetail) {
    return (
      <Box key={item.executionId} flexDirection="column" minWidth={0}>
        <Box minWidth={0}>
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
          {extraDetail ? (
            <Box flexShrink={0}>
              <Text dimColor>{` — ${extraDetail}`}</Text>
            </Box>
          ) : null}
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
      {extraDetail ? (
        <Box flexShrink={0}>
          <Text dimColor>{` — ${extraDetail}`}</Text>
        </Box>
      ) : null}
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
  followOffset = maxOffset,
): TaskDetailScrollState {
  const clampedFollowOffset = Math.min(followOffset, maxOffset);
  if (state.executionId !== executionId) {
    return { executionId, followsTail: true, offset: clampedFollowOffset };
  }
  if (state.followsTail) {
    return { ...state, offset: clampedFollowOffset };
  }
  return { ...state, offset: Math.min(state.offset, maxOffset) };
}

export function taskDetailVisibleScrollOffset(
  state: TaskDetailScrollState,
  maxOffset: number,
  followOffset = maxOffset,
): number {
  if (state.followsTail) return Math.min(followOffset, maxOffset);
  return Math.min(state.offset, maxOffset);
}

function taskDetailScrollOffsetFollowsTail(
  offset: number,
  maxOffset: number,
  followOffset = maxOffset,
): boolean {
  return offset === Math.min(followOffset, maxOffset);
}

export function moveTaskDetailScrollState(
  state: TaskDetailScrollState,
  maxOffset: number,
  direction: 'down' | 'up',
  followOffset = maxOffset,
): TaskDetailScrollState {
  const offset = taskDetailVisibleScrollOffset(state, maxOffset, followOffset);
  if (direction === 'up') {
    const nextOffset = Math.max(0, offset - 1);
    return {
      ...state,
      followsTail: taskDetailScrollOffsetFollowsTail(
        nextOffset,
        maxOffset,
        followOffset,
      ),
      offset: nextOffset,
    };
  }
  const nextOffset = Math.min(maxOffset, offset + 1);
  return {
    ...state,
    followsTail: taskDetailScrollOffsetFollowsTail(
      nextOffset,
      maxOffset,
      followOffset,
    ),
    offset: nextOffset,
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
    item.status,
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
  const [scrollState, setScrollState] = useState<TaskDetailScrollState>(() => ({
    executionId: item.executionId,
    followsTail: true,
    offset: followOffset,
  }));
  const offset = taskDetailVisibleScrollOffset(
    scrollState,
    maxOffset,
    followOffset,
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
      ),
    );
  }, [item.executionId, followOffset, maxOffset]);

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
        moveTaskDetailScrollState(current, maxOffset, 'up', followOffset),
      );
    }
    if (action.kind === 'down') {
      setScrollState((current) =>
        moveTaskDetailScrollState(current, maxOffset, 'down', followOffset),
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
  const hasItems = items.length > 0;
  const tailItem = tailExecutionId
    ? items.find((item) => item.executionId === tailExecutionId)
    : undefined;
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
          renderItem(selectedItem, selectedIndex, true, compactOverflowText)
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
                undefined,
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
            availableColumns,
          )}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
