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
  subagentPickerSelection,
  type ChildControlItem,
  type ChildControlMode,
} from '../state/childControls';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { textDisplayWidth } from '../render/terminalText';
import { KEY_HINT_SEPARATOR, KeyHints, type KeyHint } from '../ui/KeyHints';
import { POINTER } from '../ui/glyphs';
import {
  nextWrappingHighlightIndex,
  SELECT_LABEL_MAX_COLS,
} from '../ui/Select';
import {
  activeSubagentsFor,
  type ChildStreamEntries,
} from '../state/childExecutions';
import { TaskDetailView } from './TaskDetailView';
import type { StreamSlice } from '../state/cliState';

interface ChildControlPickerProps {
  readonly availableColumns?: number;
  readonly streamLabel: string | undefined;
  readonly activeStreamId: StreamTabId | undefined;
  readonly availableRows?: number;
  readonly childStreamEntries: ChildStreamEntries;
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

const ULTRA_COMPACT_PICKER_MAX_ROWS = 6;
const PICKER_HORIZONTAL_CHROME_COLUMNS = 4;

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

export function ChildControlPicker({
  availableColumns,
  streamLabel,
  activeStreamId,
  availableRows,
  childStreamEntries,
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
  const liveElapsedKey = activeStreamId
    ? liveChildExecutionElapsedKey(
        activeSubagentsFor(activeStreamId, childStreamEntries, streams),
        slice?.activeProcesses ?? [],
      )
    : undefined;
  const nowMs = useLiveNowMs(liveElapsedKey !== undefined, liveElapsedKey);
  const items = useMemo(
    () =>
      slice && activeStreamId
        ? buildChildControlItems(
            activeStreamId,
            childStreamEntries,
            streams,
            mode,
            nowMs,
          )
        : [],
    [activeStreamId, childStreamEntries, mode, nowMs, slice, streams],
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
            nextWrappingHighlightIndex({
              direction: -1,
              highlight: current,
              itemCount: items.length,
            }),
          );
          return;
        case 'down':
          setHighlight((current) =>
            nextWrappingHighlightIndex({
              direction: 1,
              highlight: current,
              itemCount: items.length,
            }),
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
