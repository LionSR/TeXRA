// Ctrl-R reverse-incremental search popup.
//
// Mounts over the input bar (rendered above it). Each keystroke narrows the
// most-recent match from the in-memory ring; Up cycles to the next older
// match, Enter commits the selected line back into the input, Esc cancels.

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { isCtrlInput } from '@cli/tui/inputKeys';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import { COLOR_ACCENT } from '@cli/tui/ui/colors';
import { BaseTextInput } from './BaseTextInput';
import type { InputHistory } from '../history/inputHistory';

interface ReverseSearchProps {
  readonly history: InputHistory;
  /** Commit the selected line — caller writes it into the input. */
  readonly onCommit: (line: string) => void;
  /** User hit Esc or Ctrl-G — close without committing. */
  readonly onCancel: () => void;
}

export const REVERSE_SEARCH_ROWS = 5;

export function ReverseSearch(props: ReverseSearchProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<number | undefined>(undefined);

  const match = props.history.reverseFind(query, cursor);

  useInput((input, key) => {
    if (isCtrlInput(input, key, 'g')) {
      props.onCancel();
      return;
    }
    if (key.upArrow || isCtrlInput(input, key, 'r')) {
      // Step to the next older match.
      if (!match) return;
      const next = props.history.reverseFind(query, match.index);
      if (next) setCursor(next.index + 1);
      return;
    }
    if (key.downArrow) {
      // Reset — start from the most-recent match again.
      setCursor(undefined);
    }
  });

  return (
    <BorderedPanel
      color={COLOR_ACCENT}
      footer={
        <KeyHints
          hints={[
            { key: 'Ctrl-R / ↑', action: 'older match' },
            { key: '↓', action: 'reset' },
          ]}
        />
      }
    >
      <Box>
        <Text color={COLOR_ACCENT}>(reverse-i-search)`</Text>
        <BaseTextInput
          value={query}
          onEscape={props.onCancel}
          onChange={(value) => {
            setQuery(value);
            setCursor(undefined);
          }}
          onSubmit={() => {
            if (match) props.onCommit(match.value);
            else props.onCancel();
          }}
        />
        <Text color={COLOR_ACCENT}>`: </Text>
        {/* The popup owns a fixed 5-row reserve (REVERSE_SEARCH_ROWS); a long
            recalled command must truncate, not soft-wrap the search line into
            a 6th row that shifts the pinned input/status chrome. */}
        <Box flexGrow={1} flexShrink={1} height={1} overflowY="hidden">
          <Text wrap="truncate-end">{match?.value ?? ''}</Text>
        </Box>
      </Box>
    </BorderedPanel>
  );
}
