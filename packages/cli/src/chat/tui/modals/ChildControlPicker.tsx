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
  readonly mode: ChildControlMode;
  readonly onClose: () => void;
  readonly onFocusStream: (streamId: StreamTabId) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly slice: StreamSlice | undefined;
}

function pickerTitle(mode: ChildControlMode): string {
  return mode === 'subagents' ? 'Subagents' : 'Processes';
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
      </Box>
    </Box>
  );
}

function ProcessTailView({
  item,
  onBack,
  onKill,
}: {
  readonly item: ChildControlItem;
  readonly onBack: () => void;
  readonly onKill: () => void;
}): React.JSX.Element {
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
  });

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        Process tail
      </Text>
      <Text>{item.label}</Text>
      <Box flexDirection="column" marginTop={1}>
        {item.tailLines.length > 0 ? (
          item.tailLines.map((line, index) => (
            <Text key={`${index}:${line}`} dimColor>
              {line}
            </Text>
          ))
        ) : (
          <Text dimColor>No process output captured yet.</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'k', action: 'kill' },
            { key: 'Esc', action: 'back' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}

export function ChildControlPicker({
  activeStreamId,
  mode,
  onClose,
  onFocusStream,
  onKillExecution,
  slice,
}: ChildControlPickerProps): React.JSX.Element {
  const items = useMemo(
    () => (slice ? buildChildControlItems(slice, mode) : []),
    [mode, slice],
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
      <ProcessTailView
        item={tailItem}
        onBack={() => setTailExecutionId(undefined)}
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
            { key: 'Enter', action: mode === 'subagents' ? 'focus' : 'tail' },
            { key: 'k', action: 'kill' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
