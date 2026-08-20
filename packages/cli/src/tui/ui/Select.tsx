// Numbered select primitive for slash forms + future palettes.
//
// Renders each item with the shared POINTER glyph on the focused row and the
// TICK glyph on the currently-active value (see ./glyphs) per
// docs/prds/cli-tui-ink/2026-05-14-10-architecture.md § Intuitiveness conventions.
//
// `↑/↓` walks the rows, Enter calls `onSelect`, Esc calls `onCancel`. Items
// receive a single-key shortcut prefix so the row can be jumped to directly:
// `1`-`9` for the first nine rows, then `a`-`z` for rows 10-35.

// Third-party imports
import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState, type ReactNode } from 'react';

// Local imports - shared utilities
import { isEscapeInput, isPlainReturnInput } from '@cli/tui/inputKeys';
import { selectVisibleInlineOverflowText } from '@cli/tui/overflowText';
import { clamp, clampIndex } from '@utils/core';

// Local imports - TUI input and presentation
import { COLOR_HINT } from './colors';
import { POINTER, TICK } from './glyphs';

const SELECT_LABEL_MAX_COLS = 24;

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
  readonly labelMaxCols?: number;
  readonly maxVisibleItems?: number;
  readonly showOverflow?: boolean;
  /** Whether this list currently owns terminal input. */
  readonly isActive?: boolean;
  /** Controlled highlighted value. `null` keeps the internal keyboard cursor
   *  ready without presenting a row as selected. */
  readonly highlightedValue?: T | null;
  readonly onHighlightChange?: (value: T) => void;
  /** Disable direct 1-9/a-z activation for arrow-only lists. */
  readonly hotkeys?: boolean;
  /** Set false when this Select is a standalone focus target rather than a
   *  cyclic menu: a move past either edge clamps instead of wrapping.
   *  Defaults to true (existing wrap-around behavior). */
  readonly wrap?: boolean;
  /** Defaults to `'single'`: hotkeys (1-9, then a-z) select-and-close via
   *  `onSelect`; Enter does the same on the highlighted row; Space is
   *  unhandled. In `'multi'`, Space and hotkeys instead toggle membership via
   *  `onToggle` (caller owns the selected set and reads it back in its own
   *  `onSelect`, which Enter still calls once to submit); the tick glyph
   *  reflects `selectedValues` instead of `activeValue`. */
  readonly mode?: 'single' | 'multi';
  /** Required in `'multi'` mode: the set of currently-toggled-on values. */
  readonly selectedValues?: ReadonlySet<T>;
  /** Required in `'multi'` mode: called with the row's value on Space/hotkey. */
  readonly onToggle?: (value: T) => void;
  readonly renderItem?: (
    item: SelectItem<T>,
    state: {
      readonly active: boolean;
      readonly focused: boolean;
      readonly hiddenItemCount: number;
      readonly index: number;
      readonly overflowText?: string;
    },
  ) => ReactNode;
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

export function selectControlledHighlightIndex<T>({
  highlightedValue,
  items,
  previousIndex,
}: {
  readonly highlightedValue?: T | null;
  readonly items: ReadonlyArray<SelectItem<T>>;
  readonly previousIndex: number;
}): number {
  const controlledIndex = items.findIndex(
    (item) => item.value === highlightedValue,
  );
  return controlledIndex >= 0
    ? controlledIndex
    : clampIndex(previousIndex, items.length);
}

export function nextSelectHighlightIndex<T>({
  direction,
  highlight,
  items,
  wrap = true,
}: {
  readonly direction: -1 | 1;
  readonly highlight: number;
  readonly items: ReadonlyArray<SelectItem<T>>;
  readonly wrap?: boolean;
}): number {
  if (items.length === 0) return 0;

  const clampedHighlight = clampIndex(highlight, items.length);
  if (
    items.every((item) => item.disabled) ||
    items.every((item) => !item.disabled)
  ) {
    if (!wrap) {
      return clampIndex(clampedHighlight + direction, items.length);
    }
    return nextWrappingHighlightIndex({
      direction,
      highlight: clampedHighlight,
      itemCount: items.length,
    });
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

export function nextWrappingHighlightIndex({
  direction,
  highlight,
  itemCount,
}: {
  readonly direction: -1 | 1;
  readonly highlight: number;
  readonly itemCount: number;
}): number {
  if (itemCount <= 0) return 0;
  const clampedHighlight = clampIndex(highlight, itemCount);
  if (direction === 1) return (clampedHighlight + 1) % itemCount;
  return clampedHighlight <= 0 ? itemCount - 1 : clampedHighlight - 1;
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
    maxVisibleItems == null ? itemCount : clamp(maxVisibleItems, 0, itemCount);
  if (visibleCount <= 0) return { start: 0, end: 0 };
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

/**
 * Ink can deliver rapid key presses as one input chunk. Menus should still
 * honor the first shortcut from a tiny burst instead of silently dropping it.
 * Longer chunks are likely pasted text or a slash command racing a closing
 * form, so treating their first letter as a row shortcut is surprising.
 */
export function selectIndexForHotkeyInput(input: string): number | undefined {
  if (input.length > 2) return undefined;
  const first = input.at(0);
  return first == null ? undefined : selectIndexForHotkey(first);
}

export function isRawSelectNavigationInput(input: string): boolean {
  return input.startsWith('\u001B[') || input.startsWith('\u001BO');
}

export function isRawSelectEscChordInput(input: string): boolean {
  return (
    input.startsWith('\u001B') &&
    input.length === 2 &&
    !isRawSelectNavigationInput(input)
  );
}

export function rawSelectArrowDirection(input: string): -1 | 1 | undefined {
  if (input === '\u001B[A' || input === '\u001BOA') return -1;
  if (input === '\u001B[B' || input === '\u001BOB') return 1;
  return undefined;
}

export function Select<T>(props: SelectProps<T>): React.JSX.Element {
  const initial = selectInitialHighlightIndex({
    activeValue: props.activeValue,
    initialIndex: props.initialIndex,
    items: props.items,
  });
  const [highlight, setHighlight] = useState(initial);
  const highlightRef = useRef(initial);
  // Drop input after cancel until React commits the resulting transition. A
  // parent may reuse this Select instance for the destination screen, so the
  // guard must not remain latched across renders.
  const cancelledRef = useRef(false);

  function cancelAndDrop(): void {
    cancelledRef.current = true;
    props.onCancel();
  }

  useEffect(() => {
    const next = selectControlledHighlightIndex({
      highlightedValue: props.highlightedValue,
      items: props.items,
      previousIndex: highlightRef.current,
    });
    highlightRef.current = next;
    setHighlight(next);
    // Item identity is intentional: a same-length reorder must relocate a
    // controlled highlighted value. Callers stabilize unchanged item arrays.
  }, [props.highlightedValue, props.items]);

  useEffect(() => {
    cancelledRef.current = false;
  });

  const visibleRange = visibleSelectRange({
    itemCount: props.items.length,
    highlight,
    maxVisibleItems: props.maxVisibleItems,
  });
  const hiddenBefore = visibleRange.start;
  const hiddenAfter = props.items.length - visibleRange.end;
  const visibleItems = props.items.slice(visibleRange.start, visibleRange.end);
  const inlineOverflowText = selectVisibleInlineOverflowText({
    hiddenAfter,
    hiddenBefore,
    showOverflow: props.showOverflow,
    visibleItemCount: visibleItems.length,
  });

  const moveHighlight = (direction: -1 | 1): void => {
    const current = highlightRef.current;
    const next = nextSelectHighlightIndex({
      direction,
      highlight: current,
      items: props.items,
      wrap: props.wrap,
    });
    if (props.wrap === false && next === current) {
      return;
    }
    highlightRef.current = next;
    setHighlight(next);
    const item = props.items[next];
    if (item) props.onHighlightChange?.(item.value);
  };

  useInput(
    (input, key) => {
      if (cancelledRef.current) return;
      const rawNavigationInput = isRawSelectNavigationInput(input);
      const rawArrowDirection = rawSelectArrowDirection(input);
      if (key.upArrow || rawArrowDirection === -1) {
        moveHighlight(-1);
        return;
      }
      if (key.downArrow || rawArrowDirection === 1) {
        moveHighlight(1);
        return;
      }
      // A fast Esc followed by another key can arrive as an Alt/meta chord or
      // as raw ESC + one printable key. Select forms have no meta shortcuts, so
      // treat that as cancel-and-drop without swallowing raw terminal navigation.
      if (
        isEscapeInput(input, key) ||
        (key.meta && !rawNavigationInput) ||
        isRawSelectEscChordInput(input)
      ) {
        cancelAndDrop();
        return;
      }
      if (props.mode === 'multi' && input === ' ') {
        const choice = props.items[highlightRef.current];
        if (choice && !choice.disabled) props.onToggle?.(choice.value);
        return;
      }
      if (isPlainReturnInput(input, key)) {
        const choice = props.items[highlightRef.current];
        if (choice && !choice.disabled) props.onSelect(choice.value);
        return;
      }
      if (!key.ctrl && input.length > 2) {
        if (rawNavigationInput) return;
        cancelAndDrop();
        return;
      }
      // Single-key jumps (1-9, then a-z) for direct selection (or, in multi
      // mode, direct toggle). Ignore Ctrl chords: Ctrl+C exits the app through
      // App's unified handler, and other Ctrl+<letter> chords were never
      // meant as row hotkeys.
      if (!key.ctrl && props.hotkeys !== false) {
        const idx = selectIndexForHotkeyInput(input);
        if (idx != null && idx < props.items.length) {
          const choice = props.items[idx];
          if (choice && !choice.disabled) {
            highlightRef.current = idx;
            props.onHighlightChange?.(choice.value);
            if (props.mode === 'multi') {
              // Unlike single-select's onSelect, onToggle doesn't end this
              // list's lifetime — it keeps rendering, so the visible pointer
              // and scroll window must actually follow the hotkey press.
              setHighlight(idx);
              props.onToggle?.(choice.value);
            } else {
              props.onSelect(choice.value);
            }
          }
        }
      }
    },
    { isActive: props.isActive ?? true },
  );

  return (
    <Box flexDirection="column" aria-role="listbox">
      {props.showOverflow && hiddenBefore > 0 ? (
        <Text dimColor>{`… ${hiddenBefore} earlier`}</Text>
      ) : null}
      {visibleItems.map((item, offset) => {
        const i = visibleRange.start + offset;
        const focused = props.highlightedValue !== null && i === highlight;
        const active =
          props.mode === 'multi'
            ? (props.selectedValues?.has(item.value) ?? false)
            : item.value === props.activeValue;
        const pointer = focused ? POINTER : ' ';
        const tick = active ? TICK : ' ';
        const hotkey = selectHotkeyForIndex(i);
        const shortcut = hotkey ? `${hotkey}.` : '  ';
        const showInlineOverflow = focused && inlineOverflowText;
        const focusColor = focused ? COLOR_HINT : undefined;
        return (
          <Box
            key={selectItemRenderKey(item, i)}
            minWidth={0}
            aria-role="option"
            aria-state={{
              selected: focused,
              checked: active,
              disabled: item.disabled,
            }}
          >
            {props.renderItem ? (
              props.renderItem(item, {
                active,
                focused,
                hiddenItemCount: hiddenBefore + hiddenAfter,
                index: i,
                ...(showInlineOverflow
                  ? { overflowText: inlineOverflowText }
                  : {}),
              })
            ) : (
              <>
                {/* Pointer/tick glyphs are decorative for screen readers — the
                    option role + state above already announce focus/active. The
                    hotkey stays audible because it is actionable. */}
                <Box flexShrink={0}>
                  <Text aria-hidden color={focusColor}>
                    {pointer} {tick}{' '}
                  </Text>
                  <Text color={focusColor}>{shortcut} </Text>
                </Box>
                <Box
                  flexShrink={0}
                  maxWidth={props.labelMaxCols ?? SELECT_LABEL_MAX_COLS}
                >
                  <Text
                    color={focusColor}
                    dimColor={item.disabled}
                    wrap="truncate-end"
                  >
                    {item.label}
                  </Text>
                </Box>
                {showInlineOverflow ? (
                  <Box flexShrink={0}>
                    <Text dimColor>{` — ${inlineOverflowText}`}</Text>
                  </Box>
                ) : null}
                {item.description && !showInlineOverflow ? (
                  <Box minWidth={0} flexShrink={1}>
                    <Text
                      dimColor
                      wrap="truncate-end"
                    >{` — ${item.description}`}</Text>
                  </Box>
                ) : null}
              </>
            )}
          </Box>
        );
      })}
      {props.showOverflow && hiddenAfter > 0 ? (
        <Text dimColor>{`… ${hiddenAfter} more`}</Text>
      ) : null}
    </Box>
  );
}
