// Numbered select primitive for slash forms + future palettes.
//
// Renders each item with a `›` pointer on the focused row (Ink figures.pointer
// equivalent in plain ASCII) and a `✓` on the currently-active value per
// docs/prd/cli-tui-ink/10-architecture.md § Intuitiveness conventions.
//
// `↑/↓` walks the rows, Enter calls `onSelect`, Esc calls `onCancel`. Items
// receive a 1-based numeric prefix so digit shortcuts can jump directly.

import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import { isPlainReturnInput } from '../input/inputKeys';

export const SELECT_LABEL_MAX_COLS = 24;

export interface SelectItem<T> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface SelectProps<T> {
  readonly items: ReadonlyArray<SelectItem<T>>;
  /** Value currently active in the system (rendered with a tick). */
  readonly activeValue?: T;
  readonly onSelect: (value: T) => void;
  readonly onCancel: () => void;
  /** Focus the Nth item on mount (defaults to the active value's index, or 0). */
  readonly initialIndex?: number;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

export function Select<T>(props: SelectProps<T>): React.JSX.Element {
  const activeIndex = props.items.findIndex(
    (it) => it.value === props.activeValue,
  );
  const initial = clampIndex(
    props.initialIndex ?? (activeIndex >= 0 ? activeIndex : 0),
    props.items.length,
  );
  const [highlight, setHighlight] = useState(initial);

  useEffect(() => {
    setHighlight((h) => clampIndex(h, props.items.length));
  }, [props.items.length]);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) {
      setHighlight((h) =>
        clampIndex(h <= 0 ? props.items.length - 1 : h - 1, props.items.length),
      );
      return;
    }
    if (key.downArrow) {
      setHighlight((h) =>
        props.items.length === 0 ? 0 : (h + 1) % props.items.length,
      );
      return;
    }
    if (isPlainReturnInput(input, key)) {
      const choice = props.items[highlight];
      if (choice && !choice.disabled) props.onSelect(choice.value);
      return;
    }
    // 1-9 digit jumps for direct selection.
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
      const idx = digit - 1;
      if (idx < props.items.length) {
        const choice = props.items[idx];
        if (choice && !choice.disabled) {
          setHighlight(idx);
          props.onSelect(choice.value);
        }
      }
    }
  });

  return (
    <Box flexDirection="column">
      {props.items.map((item, i) => {
        const focused = i === highlight;
        const active = item.value === props.activeValue;
        const pointer = focused ? '›' : ' ';
        const tick = active ? '✓' : ' ';
        const numeric = i < 9 ? `${i + 1}.` : '  ';
        return (
          <Box key={String(item.value)} minWidth={0}>
            <Box flexShrink={0}>
              <Text color={focused ? 'cyan' : undefined}>
                {pointer} {tick} {numeric}{' '}
              </Text>
            </Box>
            <Box flexShrink={0} maxWidth={SELECT_LABEL_MAX_COLS}>
              <Text
                color={focused ? 'cyan' : undefined}
                dimColor={item.disabled}
                wrap="truncate-end"
              >
                {item.label}
              </Text>
            </Box>
            {item.description ? (
              <Text
                dimColor
                wrap="truncate-end"
              >{` — ${item.description}`}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
