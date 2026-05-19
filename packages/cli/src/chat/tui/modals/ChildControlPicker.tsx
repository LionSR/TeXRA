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
  nextPickerIndex,
  type ChildControlItem,
  type ChildControlMode,
} from '../state/childControls';
import type { StreamSlice } from '../state/cliState';
import { KeyHints } from '../ui/KeyHints';

export interface ChildControlPickerProps {
  readonly activeStreamId: StreamTabId | undefined;
  readonly availableRows?: number;
  readonly mode: ChildControlMode;
  readonly onClose: () => void;
  readonly onFocusStream: (streamId: StreamTabId) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly slice: StreamSlice | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}

function pickerTitle(mode: ChildControlMode): string {
  return mode === 'subagents' ? 'Subagents' : 'Background tasks';
}

function renderItem(
  item: ChildControlItem,
  index: number,
  highlighted: boolean,
): React.JSX.Element {
  return (
    <Box key={item.executionId} flexDirection="column">
      <Box>
        <Text color={highlighted ? 'cyan' : undefined}>
          {highlighted ? '›' : ' '} {index + 1}.{' '}
        </Text>
        <Text color={highlighted ? 'cyan' : undefined}>{item.label}</Text>
        {item.description ? (
          <Text dimColor>{` — ${item.description}`}</Text>
        ) : null}
        {item.command !== item.label ? (
          <Text dimColor>{` — ${item.command}`}</Text>
        ) : null}
      </Box>
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
      <Box width={10}>
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

function TaskDetailView({
  availableRows,
  item,
  onBack,
  onFocusStream,
  onKill,
}: {
  readonly availableRows?: number;
  readonly item: ChildControlItem;
  readonly onBack: () => void;
  readonly onFocusStream: () => void;
  readonly onKill: () => void;
}): React.JSX.Element {
  const [scrollOffset, setScrollOffset] = useState(0);
  const metaRows = [
    item.kind === 'process' ? 'shell' : 'stream',
    item.label,
    item.status,
    item.elapsed,
  ].filter(Boolean).length;
  const layout = computeTaskDetailLayout({
    availableRows,
    hasTailLines: item.tailLines.length > 0,
    metaRows,
  });
  const visibleLineCount = layout.visibleLineCount;
  const maxOffset = Math.max(0, item.tailLines.length - visibleLineCount);
  const offset = Math.min(scrollOffset, maxOffset);
  const visibleTail = item.tailLines.slice(offset, offset + visibleLineCount);
  const compactMeta = [
    item.kind === 'process' ? 'shell' : 'stream',
    item.label,
    item.status,
    item.elapsed,
  ]
    .filter(Boolean)
    .join(' · ');

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, maxOffset));
  }, [maxOffset]);

  useInput((input, key) => {
    const action = childPickerKeyAction({
      input,
      escape: key.escape,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
    });
    if (action.kind === 'close') onBack();
    if (action.kind === 'kill') onKill();
    if (action.kind === 'up') {
      setScrollOffset((current) => Math.max(0, current - 1));
    }
    if (action.kind === 'down') {
      setScrollOffset((current) => Math.min(maxOffset, current + 1));
    }
    if (input.toLowerCase() === 'f' && item.childStreamId) onFocusStream();
  });

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
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
          <Box width={10}>
            <Text bold>Command:</Text>
          </Box>
          <Text wrap="truncate-end">{item.command}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={layout.compact ? 0 : 1}>
        <Text bold>Output:</Text>
        {item.tailLines.length > 0 && visibleLineCount > 0 ? (
          visibleTail.map((line, index) => (
            <Text key={`${index}:${line}`} dimColor>
              {line}
            </Text>
          ))
        ) : item.tailLines.length > 0 ||
          visibleLineCount === 0 ? null : item.childStreamId ? (
          <Text dimColor>Open the task stream to see its live transcript.</Text>
        ) : (
          <Text dimColor>No output captured yet.</Text>
        )}
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
              { key: 'k', action: 'kill' },
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
  activeStreamId,
  availableRows,
  mode,
  onClose,
  onFocusStream,
  onKillExecution,
  slice,
  streams,
}: ChildControlPickerProps): React.JSX.Element {
  const items = useMemo(
    () => (slice ? buildChildControlItems(slice, mode, streams) : []),
    [mode, slice, streams],
  );
  const [highlight, setHighlight] = useState(0);
  const [tailExecutionId, setTailExecutionId] = useState<string | undefined>(
    undefined,
  );
  const tailItem = tailExecutionId
    ? items.find((item) => item.executionId === tailExecutionId)
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
        escape: key.escape,
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
          const item = items[highlight];
          if (!item) return;
          if (mode === 'subagents' && item.childStreamId) {
            onFocusStream(item.childStreamId);
            onClose();
            return;
          }
          setTailExecutionId(item.executionId);
          return;
        }
        case 'kill': {
          const item = items[highlight];
          if (!item) return;
          onKillExecution(item.executionId);
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

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        {pickerTitle(mode)}
      </Text>
      {activeStreamId ? (
        <Text dimColor>{`Parent stream: ${activeStreamId}`}</Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {items.length > 0 ? (
          items.map((item, index) =>
            renderItem(item, index, index === highlight),
          )
        ) : (
          <Text dimColor>No active {pickerTitle(mode).toLowerCase()}.</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: mode === 'subagents' ? 'focus' : 'view' },
            { key: 'k', action: 'kill' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
