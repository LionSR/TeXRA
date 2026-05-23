// Numbered select primitive for slash forms + future palettes.
//
// Renders each item with a `›` pointer on the focused row (Ink figures.pointer
// equivalent in plain ASCII) and a `✓` on the currently-active value per
// docs/prd/cli-tui-ink/10-architecture.md § Intuitiveness conventions.
//
// `↑/↓` walks the rows, Enter calls `onSelect`, Esc calls `onCancel`. Items
// 1-9 are reachable by digit; items 10-35 by a-z (lowercase). Beyond 35,
// only arrow-key navigation reaches the row.

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

const A_LOWERCASE = 'a'.charCodeAt(0);
const Z_LOWERCASE = 'z'.charCodeAt(0);

/** Map a typed keystroke to a zero-based item index, or undefined if unbound. */
export function hotkeyIndex(input: string): number | undefined {
  if (input.length !== 1) return undefined;
  const digit = Number(input);
  if (Number.isInteger(digit) && digit >= 1 && digit <= 9) return digit - 1;
  const code = input.charCodeAt(0);
  if (code >= A_LOWERCASE && code <= Z_LOWERCASE) return code - A_LOWERCASE + 9;
  return undefined;
}

/** Render the leading slot for an item: `1.`-`9.`, `a.`-`z.`, or two spaces. */
export function selectIndexLabel(index: number): string {
  if (index < 9) return `${index + 1}.`;
  if (index < 9 + 26) return `${String.fromCharCode(A_LOWERCASE + index - 9)}.`;
  return '  ';
}

/** Footer hint string matching the active hotkey range for a given item count. */
export function selectHotkeyHint(itemCount: number): string {
  if (itemCount <= 0) return '';
  if (itemCount <= 9) return '1-9';
  return '1-9 a-z';
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
    // 1-9 digit jumps for items 1-9; a-z covers items 10-35 so pickers with
    // many remote agents (the worst offender is `/agent`, which can list 18+)
    // do not have a silent number-less tail.
    const idx = hotkeyIndex(input);
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
        const numeric = selectIndexLabel(i);
        return (
          <Box key={selectItemRenderKey(item, i)} minWidth={0}>
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
      {props.showOverflow && hiddenAfter > 0 ? (
        <Text dimColor>{`... ${hiddenAfter} more`}</Text>
      ) : null}
    </Box>
  );
}
