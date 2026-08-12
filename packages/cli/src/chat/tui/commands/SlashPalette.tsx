// Slash command palette: pick with arrow keys + Enter or Tab; Esc dismisses it.

import { Box, Text, useInput } from 'ink';
import { useState, useEffect } from 'react';

import { isEscapeInput, isPlainReturnInput } from '@cli/tui/inputKeys';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import { nextWrappingHighlightIndex } from '@cli/tui/ui/Select';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { POINTER } from '@cli/tui/ui/glyphs';
import { clamp } from '@utils/core';
import {
  matchSlashCommands,
  slashPickIntent,
  type SlashCommand,
  type SlashPickIntent,
} from './slashRegistry';

export interface SlashPaletteProps {
  /** The current input value (excluding the leading `/`, after the slash). */
  readonly query: string;
  /** Accepted: caller should replace the input with the chosen command name. */
  readonly onPick: (command: SlashCommand, intent: SlashPickIntent) => void;
  readonly onCancel: () => void;
}

const MAX_VISIBLE_COMMANDS = 8;
export const SLASH_PALETTE_ROWS = 13;

const COMMAND_DESCRIPTION_GAP = 2;

export interface SlashPaletteWindow {
  readonly start: number;
  readonly end: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

// Wraparound highlight stepping is shared with `ui/Select.tsx`. The window
// below stays local: scrolling through the middle of a long list shows one
// fewer row than at the edges, on purpose, so both overflow markers ("… N
// earlier" / "… N more") can be visible at once — unlike `Select`'s simple
// centered `visibleSelectRange`.
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

  const visibleAtEdge = clamp(maxVisibleCommands, 1, itemCount);
  if (itemCount <= visibleAtEdge) {
    return { start: 0, end: itemCount, hiddenBefore: 0, hiddenAfter: 0 };
  }

  const clamped = clamp(highlight, 0, itemCount - 1);
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

/**
 * The palette owns ↑/↓ only while it presents a real choice. With a single
 * match (e.g. a fully typed command name) the arrows must keep doing input
 * history recall in the text input, which shares the same keystrokes.
 */
export function slashPaletteOwnsArrows(matchCount: number): boolean {
  return matchCount > 1;
}

export function slashPaletteEnterHintAction(
  command: SlashCommand | undefined,
): string {
  if (!command) return 'run';
  if (command.formComponent) return 'open';
  return slashPickIntent(command, 'enter') === 'submit' ? 'run' : 'complete';
}

export function slashPaletteCommandLabelWidth(
  commands: readonly SlashCommand[],
): number {
  return commands.reduce(
    (width, command) =>
      Math.max(width, `  /${command.name}`.length + COMMAND_DESCRIPTION_GAP),
    0,
  );
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
    const clamped = matchCount === 0 ? 0 : clamp(highlight, 0, matchCount - 1);
    if (clamped !== highlight) setHighlight(clamped);
  }, [matchCount, highlight]);

  useInput(
    (input, key) => {
      if (isEscapeInput(input, key)) {
        props.onCancel();
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (!slashPaletteOwnsArrows(matchCount)) return;
        setHighlight((h) =>
          nextWrappingHighlightIndex({
            direction: key.upArrow ? -1 : 1,
            highlight: h,
            itemCount: matchCount,
          }),
        );
        return;
      }
      const returnPressed = isPlainReturnInput(input, key);
      if (returnPressed || key.tab || input === '\t') {
        const chosen = matches[highlight];
        if (chosen) {
          props.onPick(
            chosen,
            slashPickIntent(chosen, returnPressed ? 'enter' : 'tab'),
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
  const commandLabelWidth = slashPaletteCommandLabelWidth(visible);

  return (
    <Box
      borderStyle="single"
      borderColor={COLOR_HINT}
      flexDirection="column"
      paddingX={1}
    >
      {window.hiddenBefore > 0 ? (
        <Text dimColor>{`  … ${window.hiddenBefore} earlier`}</Text>
      ) : null}
      {visible.map((cmd, offset) => {
        const i = window.start + offset;
        return (
          <Box key={cmd.name} flexDirection="row">
            <Box flexShrink={0} width={commandLabelWidth}>
              <Text color={i === highlight ? COLOR_HINT : undefined}>
                {i === highlight ? POINTER : ' '} /{cmd.name}
              </Text>
            </Box>
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {cmd.description}
              </Text>
            </Box>
          </Box>
        );
      })}
      {window.hiddenAfter > 0 ? (
        <Text dimColor>{`  … ${window.hiddenAfter} more`}</Text>
      ) : null}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            ...(slashPaletteOwnsArrows(matchCount)
              ? [{ key: '↑/↓', action: 'navigate' }]
              : []),
            {
              key: 'Enter',
              action: slashPaletteEnterHintAction(highlightedCommand),
            },
            { key: 'Esc', action: 'close' },
            { key: 'Tab', action: 'complete' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
