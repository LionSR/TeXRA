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

const MAX_VISIBLE_COMMANDS = 8;
export const SLASH_PALETTE_ROWS = 13;

export interface SlashPaletteWindow {
  readonly start: number;
  readonly end: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

function clampHighlight(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(index, 0), itemCount - 1);
}

export function nextSlashPaletteHighlight({
  direction,
  highlight,
  itemCount,
}: {
  readonly direction: -1 | 1;
  readonly highlight: number;
  readonly itemCount: number;
}): number {
  if (itemCount <= 0) return 0;
  const clamped = clampHighlight(highlight, itemCount);
  if (direction === 1) return (clamped + 1) % itemCount;
  return clamped <= 0 ? itemCount - 1 : clamped - 1;
}

export function slashPaletteWindow({
  highlight,
  itemCount,
  maxVisibleCommands = MAX_VISIBLE_COMMANDS,
}: {
  readonly highlight: number;
  readonly itemCount: number;
  readonly maxVisibleCommands?: number;
}): SlashPaletteWindow {
  if (itemCount <= 0) {
    return { start: 0, end: 0, hiddenBefore: 0, hiddenAfter: 0 };
  }

  const visibleAtEdge = Math.min(Math.max(1, maxVisibleCommands), itemCount);
  if (itemCount <= visibleAtEdge) {
    return { start: 0, end: itemCount, hiddenBefore: 0, hiddenAfter: 0 };
  }

  const clamped = clampHighlight(highlight, itemCount);
  if (clamped < visibleAtEdge) {
    return {
      start: 0,
      end: visibleAtEdge,
      hiddenBefore: 0,
      hiddenAfter: itemCount - visibleAtEdge,
    };
  }

  const bottomStart = itemCount - visibleAtEdge;
  if (clamped >= bottomStart) {
    return {
      start: bottomStart,
      end: itemCount,
      hiddenBefore: bottomStart,
      hiddenAfter: 0,
    };
  }

  const visibleInMiddle = Math.max(1, visibleAtEdge - 1);
  const centerOffset = Math.floor(visibleInMiddle / 2);
  const start = Math.min(
    Math.max(1, clamped - centerOffset),
    itemCount - visibleInMiddle - 1,
  );
  const end = start + visibleInMiddle;
  return {
    start,
    end,
    hiddenBefore: start,
    hiddenAfter: itemCount - end,
  };
}

export function slashPaletteEnterHintAction(
  command: SlashCommand | undefined,
): string {
  if (!command) return 'run';
  if (command.formComponent) return 'open';
  return slashPickIntent(command, 'enter') === 'submit' ? 'run' : 'complete';
}

export function SlashPalette(
  props: SlashPaletteProps,
): React.JSX.Element | null {
  const matches = matchSlashCommands(props.query);
  const [highlight, setHighlight] = useState(0);
  const matchCount = matches.length;

  // Whenever the match list resizes (user kept typing), clamp the cursor
  // so it doesn't point past the end.
  useEffect(() => {
    if (matchCount === 0) {
      if (highlight !== 0) setHighlight(0);
      return;
    }
    if (highlight < 0 || highlight >= matchCount) {
      setHighlight(clampHighlight(highlight, matchCount));
    }
  }, [matchCount, highlight]);

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onCancel();
        return;
      }
      if (key.upArrow) {
        setHighlight((h) =>
          nextSlashPaletteHighlight({
            direction: -1,
            highlight: h,
            itemCount: matchCount,
          }),
        );
        return;
      }
      if (key.downArrow) {
        setHighlight((h) =>
          nextSlashPaletteHighlight({
            direction: 1,
            highlight: h,
            itemCount: matchCount,
          }),
        );
        return;
      }
      if (isPlainReturnInput(input, key) || key.tab || input === '\t') {
        const chosen = matches[highlight];
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
    { isActive: matchCount > 0 },
  );

  if (matchCount === 0) return null;
  const window = slashPaletteWindow({ highlight, itemCount: matchCount });
  const visible = matches.slice(window.start, window.end);
  const highlightedCommand = matches[highlight];

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      {window.hiddenBefore > 0 ? (
        <Text dimColor>{`  … ${window.hiddenBefore} earlier`}</Text>
      ) : null}
      {visible.map((cmd, offset) => {
        const i = window.start + offset;
        return (
          <Box key={cmd.name}>
            <Text color={i === highlight ? 'cyan' : undefined}>
              {i === highlight ? '›' : ' '} /{cmd.name}
            </Text>
            <Text dimColor>{`  ${cmd.description}`}</Text>
          </Box>
        );
      })}
      {window.hiddenAfter > 0 ? (
        <Text dimColor>{`  … ${window.hiddenAfter} more`}</Text>
      ) : null}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            {
              key: 'Enter',
              action: slashPaletteEnterHintAction(highlightedCommand),
            },
            { key: 'Tab', action: 'complete' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
