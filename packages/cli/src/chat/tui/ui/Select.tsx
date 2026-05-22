// Numbered select primitive for slash forms + future palettes.
//
// Renders each item with a `›` pointer on the focused row (Ink figures.pointer
// equivalent in plain ASCII) and a `✓` on the currently-active value per
// docs/prd/cli-tui-ink/10-architecture.md § Intuitiveness conventions.
//
// `↑/↓` walks the rows, Enter calls `onSelect`, Esc calls `onCancel`. Items
// receive a single-key shortcut prefix so the row can be jumped to directly:
// `1`-`9` for the first nine rows, then `a`-`z` for rows 10-35.

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
  readonly maxVisibleItems?: number;
  readonly showOverflow?: boolean;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

export function visibleSelectRange({
  itemCount,
  highlight,
  maxVisibleItems,
}: {
  readonly itemCount: number;
  readonly highlight: number;
  readonly maxVisibleItems: number | undefined;
}): { readonly start: number; readonly end: number } {
  if (itemCount <= 0) return { start: 0, end: 0 };
  const visibleCount =
    maxVisibleItems == null
      ? itemCount
      : Math.min(Math.max(1, maxVisibleItems), itemCount);
  const clampedHighlight = clampIndex(highlight, itemCount);
  const centerOffset = Math.floor(visibleCount / 2);
  const start = Math.min(
    Math.max(0, clampedHighlight - centerOffset),
    itemCount - visibleCount,
  );
  return { start, end: start + visibleCount };
}

export function selectItemRenderKey<T>(
  item: SelectItem<T>,
  index: number,
): string {
  return `${index}:${item.label}`;
}

/**
 * Single-key shortcut for a row: `1`-`9` for the first nine, then `a`-`z` for
 * rows 10-35. Rows beyond that have no shortcut (undefined).
 */
export function selectHotkeyForIndex(index: number): string | undefined {
  if (index < 0) return undefined;
  if (index < 9) return String(index + 1);
  const letterIndex = index - 9;
  if (letterIndex < 26) return String.fromCharCode(97 + letterIndex);
  return undefined;
}

/** Inverse of {@link selectHotkeyForIndex}: maps a typed key to a row index. */
export function selectIndexForHotkey(input: string): number | undefined {
  if (input.length !== 1) return undefined;
  if (input >= '1' && input <= '9') {
    return input.charCodeAt(0) - '1'.charCodeAt(0);
  }
  const lower = input.toLowerCase();
  if (lower >= 'a' && lower <= 'z') {
    return 9 + (lower.charCodeAt(0) - 'a'.charCodeAt(0));
  }
  return undefined;
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

  const visibleRange = visibleSelectRange({
    itemCount: props.items.length,
    highlight,
    maxVisibleItems: props.maxVisibleItems,
  });
  const hiddenBefore = visibleRange.start;
  const hiddenAfter = props.items.length - visibleRange.end;
  const visibleItems = props.items.slice(visibleRange.start, visibleRange.end);

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
    // Single-key jumps (1-9, then a-z) for direct selection.
    const idx = selectIndexForHotkey(input);
    if (idx != null && idx < props.items.length) {
      const choice = props.items[idx];
      if (choice && !choice.disabled) {
        setHighlight(idx);
        props.onSelect(choice.value);
      }
    }
  });

  return (
    <Box flexDirection="column">
      {props.showOverflow && hiddenBefore > 0 ? (
        <Text dimColor>{`... ${hiddenBefore} earlier`}</Text>
      ) : null}
      {visibleItems.map((item, offset) => {
        const i = visibleRange.start + offset;
        const focused = i === highlight;
        const active = item.value === props.activeValue;
        const pointer = focused ? '›' : ' ';
        const tick = active ? '✓' : ' ';
        const hotkey = selectHotkeyForIndex(i);
        const shortcut = hotkey ? `${hotkey}.` : '  ';
        return (
          <Box key={selectItemRenderKey(item, i)} minWidth={0}>
            <Box flexShrink={0}>
              <Text color={focused ? 'cyan' : undefined}>
                {pointer} {tick} {shortcut}{' '}
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
      {props.showOverflow && hiddenAfter > 0 ? (
        <Text dimColor>{`... ${hiddenAfter} more`}</Text>
      ) : null}
    </Box>
  );
}
