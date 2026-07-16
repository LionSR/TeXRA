// Child execution picker for the CLI TUI.

// Third-party imports
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';

import { Box, Text, useInput } from 'ink';

// Local imports - shared schemas
import type { StreamTabId } from '@shared/schemas';

// Local imports - CLI state and UI
import { clampIndex } from '@utils/core';

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
import { KeyHints } from '../ui/KeyHints';
import { BorderedPanel } from '../ui/BorderedPanel';
import { COLOR_HINT } from '../ui/colors';
import { POINTER } from '../ui/glyphs';
import {
  nextWrappingHighlightIndex,
  visibleSelectRange,
  SELECT_LABEL_MAX_COLS,
} from '../ui/Select';
import { computeSelectWindowSize } from '../forms/_shared/selectWindow';
import { compactPickerOverflowText } from '../render/overflowText';
import {
  activeSubagentsFor,
  type ChildStreamEntries,
} from '../state/childExecutions';
import { TaskDetailView } from './TaskDetailView';
import { pickerKeyHintsForColumns } from './childControlPickerHints';
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
  const color = highlighted ? COLOR_HINT : undefined;
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
  const chromeRows =
    2 + // border
    1 + // title
    Math.max(0, scopeLineCount) +
    Math.max(0, listMarginRows) +
    Math.max(0, extraListRowCount) +
    Math.max(0, hintsMarginRows) +
    1; // hints row
  const { maxVisibleItems, showOverflow } = computeSelectWindowSize({
    availableRows: rows,
    itemCount,
    chromeRows,
  });
  const { start, end } = visibleSelectRange({
    itemCount,
    highlight,
    maxVisibleItems,
  });
  return {
    end,
    hiddenAfter: showOverflow ? Math.max(0, itemCount - end) : 0,
    hiddenBefore: showOverflow ? start : 0,
    start,
    visibleCount: end - start,
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
        <Text bold color={COLOR_HINT} wrap="truncate-end">
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
    <BorderedPanel
      color={COLOR_HINT}
      width={availableColumns}
      title={pickerTitle(mode)}
      footer={
        <KeyHints
          hints={pickerKeyHintsForColumns(
            mode,
            items.length,
            selectedItem?.killable ?? false,
            hintColumns,
          )}
          confirmCancel={false}
        />
      }
      footerMarginTop={stackSelectedSubagent || compactEmptyPicker ? 0 : 1}
    >
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
    </BorderedPanel>
  );
}
