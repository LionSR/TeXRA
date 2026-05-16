// Slash command palette — pops up as the user types `/...` in the input bar.
//
// Phase 5 ships the inline-action shape only. Pick with arrow keys + Enter or
// Tab to accept; Esc dismisses the palette without changing the input.

import { Box, Text, useInput } from 'ink';
import { useState, useEffect } from 'react';

import { matchSlashCommands, type SlashCommand } from './slashRegistry';
import { KeyHints } from '../ui/KeyHints';

export interface SlashPaletteProps {
  /** The current input value (excluding the leading `/`, after the slash). */
  readonly query: string;
  /** Accepted: caller should replace the input with the chosen command name. */
  readonly onPick: (command: SlashCommand) => void;
  readonly onCancel: () => void;
}

const MAX_VISIBLE = 8;

export function SlashPalette(
  props: SlashPaletteProps,
): React.JSX.Element | null {
  const matches = matchSlashCommands(props.query);
  const [highlight, setHighlight] = useState(0);

  // Whenever the match list resizes (user kept typing), clamp the cursor
  // so it doesn't point past the end.
  useEffect(() => {
    if (highlight >= matches.length)
      setHighlight(Math.max(0, matches.length - 1));
  }, [matches.length, highlight]);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => (h <= 0 ? matches.length - 1 : h - 1));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => (h + 1) % Math.max(matches.length, 1));
      return;
    }
    if (key.return || key.tab || input === '\t') {
      const chosen = matches[highlight];
      if (chosen) props.onPick(chosen);
    }
  });

  if (matches.length === 0) return null;
  const visible = matches.slice(0, MAX_VISIBLE);
  const truncated = matches.length - visible.length;

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      {visible.map((cmd, i) => (
        <Box key={cmd.name}>
          <Text color={i === highlight ? 'cyan' : undefined}>
            {i === highlight ? '›' : ' '} /{cmd.name}
          </Text>
          <Text dimColor>{`  ${cmd.description}`}</Text>
        </Box>
      ))}
      {truncated > 0 ? <Text dimColor>{`  … ${truncated} more`}</Text> : null}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Tab/Enter', action: 'accept' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
