// Slash command palette: pick with arrow keys + Enter or Tab; Esc dismisses it.

import { Box, Text, useInput } from 'ink';
import { useState, useEffect } from 'react';

import {
  matchSlashCommands,
  slashPickIntent,
  type SlashCommand,
  type SlashPickIntent,
} from './slashRegistry';
import { isPlainReturnInput } from '../input/inputKeys';
import { KeyHints } from '../ui/KeyHints';

export interface SlashPaletteProps {
  /** The current input value (excluding the leading `/`, after the slash). */
  readonly query: string;
  /** Accepted: caller should replace the input with the chosen command name. */
  readonly onPick: (command: SlashCommand, intent: SlashPickIntent) => void;
  readonly onCancel: () => void;
}

const MAX_VISIBLE = 8;
export const SLASH_PALETTE_ROWS = 13;

export function SlashPalette(
  props: SlashPaletteProps,
): React.JSX.Element | null {
  const matches = matchSlashCommands(props.query);
  const [highlight, setHighlight] = useState(0);
  const visible = matches.slice(0, MAX_VISIBLE);
  const visibleCount = visible.length;

  // Whenever the match list resizes (user kept typing), clamp the cursor
  // so it doesn't point past the end.
  useEffect(() => {
    if (visibleCount === 0) {
      if (highlight !== 0) setHighlight(0);
      return;
    }
    if (highlight < 0 || highlight >= visibleCount) {
      setHighlight(Math.min(Math.max(highlight, 0), visibleCount - 1));
    }
  }, [visibleCount, highlight]);

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onCancel();
        return;
      }
      if (key.upArrow) {
        setHighlight((h) => (h <= 0 ? visibleCount - 1 : h - 1));
        return;
      }
      if (key.downArrow) {
        setHighlight((h) => (h + 1) % visibleCount);
        return;
      }
      if (isPlainReturnInput(input, key) || key.tab || input === '\t') {
        const chosen = visible[highlight];
        if (chosen) {
          props.onPick(
            chosen,
            slashPickIntent(
              chosen,
              isPlainReturnInput(input, key) ? 'enter' : 'tab',
            ),
          );
        }
      }
    },
    { isActive: visibleCount > 0 },
  );

  if (visibleCount === 0) return null;
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
            { key: 'Enter', action: 'run' },
            { key: 'Tab', action: 'complete' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
