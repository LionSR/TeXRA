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

function firstEnabledSelectIndex<T>(
  items: ReadonlyArray<SelectItem<T>>,
): number {
  const index = items.findIndex((item) => !item.disabled);
  return index >= 0 ? index : 0;
}

export function selectInitialHighlightIndex<T>({
  activeValue,
  initialIndex,
  items,
}: {
  readonly activeValue?: T;
  readonly initialIndex?: number;
  readonly items: ReadonlyArray<SelectItem<T>>;
}): number {
  if (items.length === 0) return 0;
  if (initialIndex != null) {
    const clampedInitialIndex = clampIndex(initialIndex, items.length);
    if (
      !items[clampedInitialIndex]?.disabled ||
      items.every((item) => item.disabled)
    ) {
      return clampedInitialIndex;
    }
    return firstEnabledSelectIndex(items);
  }

  const activeIndex = items.findIndex((it) => it.value === activeValue);
  if (activeIndex >= 0 && !items[activeIndex]?.disabled) return activeIndex;
  return firstEnabledSelectIndex(items);
}

export function nextSelectHighlightIndex<T>({
  direction,
  highlight,
  items,
}: {
  readonly direction: -1 | 1;
  readonly highlight: number;
  readonly items: ReadonlyArray<SelectItem<T>>;
}): number {
  if (items.length === 0) return 0;

  const clampedHighlight = clampIndex(highlight, items.length);
  if (
    items.every((item) => item.disabled) ||
    items.every((item) => !item.disabled)
  ) {
    return direction === 1
      ? (clampedHighlight + 1) % items.length
      : clampedHighlight <= 0
        ? items.length - 1
        : clampedHighlight - 1;
  }

  for (
    let next = clampedHighlight + direction;
    next >= 0 && next < items.length;
    next += direction
  ) {
    if (!items[next]?.disabled) return next;
  }
  return clampedHighlight;
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
  const initial = selectInitialHighlightIndex({
    activeValue: props.activeValue,
    initialIndex: props.initialIndex,
    items: props.items,
  });
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
        nextSelectHighlightIndex({
          direction: -1,
          highlight: h,
          items: props.items,
        }),
      );
      return;
    }
    if (key.downArrow) {
      setHighlight((h) =>
        nextSelectHighlightIndex({
          direction: 1,
          highlight: h,
          items: props.items,
        }),
      );
      return;
    }
    if (isPlainReturnInput(input, key)) {
      const choice = props.items[highlight];
      if (choice && !choice.disabled) props.onSelect(choice.value);
      return;
    }
    // Single-key jumps (1-9, then a-z) for direct selection. Ignore modified
    // chords: Ctrl+C exits the app (the App's unified handler owns it now that
    // we render with exitOnCtrlC: false, so Ink no longer mutes it), and
    // Ctrl/Alt+<letter> were never meant as row hotkeys.
    if (!key.ctrl && !key.meta) {
      const idx = selectIndexForHotkey(input);
      if (idx != null && idx < props.items.length) {
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
