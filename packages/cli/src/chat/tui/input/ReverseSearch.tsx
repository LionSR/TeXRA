// Ctrl-R reverse-incremental search popup.
//
// Mounts over the input bar (rendered above it). Each keystroke narrows the
// most-recent match from the in-memory ring; Up cycles to the next older
// match, Enter commits the selected line back into the input, Esc cancels.

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import type { InputHistory } from '../history/inputHistory';
import { KeyHints } from '../ui/KeyHints';

export interface ReverseSearchProps {
  readonly history: InputHistory;
  /** Commit the selected line — caller writes it into the input. */
  readonly onCommit: (line: string) => void;
  /** User hit Esc (or Ctrl-G, which Ink reports as Ctrl-G → wired below) —
   *  close without committing. */
  readonly onCancel: () => void;
}

export function ReverseSearch(props: ReverseSearchProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<number | undefined>(undefined);

  const match = props.history.reverseFind(query, cursor);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input.toLowerCase() === 'g')) {
      props.onCancel();
      return;
    }
    if (key.upArrow || (key.ctrl && input.toLowerCase() === 'r')) {
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
    <Box
      borderStyle="round"
      borderColor="magenta"
      flexDirection="column"
      paddingX={1}
    >
      <Box>
        <Text color="magenta">(reverse-i-search)`</Text>
        <TextInput
          value={query}
          onChange={(value) => {
            setQuery(value);
            setCursor(undefined);
          }}
          onSubmit={() => {
            if (match) props.onCommit(match.value);
            else props.onCancel();
          }}
        />
        <Text color="magenta">`: </Text>
        <Text>{match?.value ?? ''}</Text>
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Ctrl-R / ↑', action: 'older match' },
            { key: '↓', action: 'reset' },
          ]}
        />
      </Box>
    </Box>
  );
}
