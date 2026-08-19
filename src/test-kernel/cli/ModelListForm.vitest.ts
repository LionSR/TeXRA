import { describe, expect, it } from 'vitest';

import {
  modelListDescription,
  modelSelectWindow,
} from '@cli/chat/tui/forms/ModelListForm';
import {
  shouldBufferAsyncListFormInput,
  shouldCloseAsyncListFormOnInput,
} from '@cli/chat/tui/forms/_shared/useAsyncListForm';
import {
  COMPACT_FORM_MAX_ROWS,
  isCompactFormRows,
} from '@cli/tui/selectWindow';
import {
  nextSelectHighlightIndex,
  selectInitialHighlightIndex,
  selectItemRenderKey,
  visibleSelectRange,
} from '@cli/tui/ui/Select';
import { selectVisibleInlineOverflowText } from '@cli/tui/overflowText';

describe('CLI ModelListForm empty state', () => {
  it.each<{
    itemCount: number;
    selectable: boolean;
    expected: string;
  }>([
    {
      itemCount: 0,
      selectable: false,
      expected: 'No model choices available.',
    },
    {
      itemCount: 0,
      selectable: true,
      expected: 'No model choices available.',
    },
    {
      itemCount: 2,
      selectable: false,
      expected:
        'Available models. Finish the active response before switching models.',
    },
    {
      itemCount: 2,
      selectable: true,
      expected: 'Choose the model for future turns.',
    },
  ])(
    'describes itemCount=$itemCount selectable=$selectable truthfully',
    ({ itemCount, selectable, expected }) => {
      expect(modelListDescription({ itemCount, selectable })).toBe(expected);
    },
  );
});

describe('CLI async list form close input', () => {
  it.each<{
    name: string;
    args: Parameters<typeof shouldCloseAsyncListFormOnInput>[0];
    expected: boolean;
  }>([
    {
      name: 'normalized Escape closes while loading',
      args: {
        input: '',
        key: { escape: true },
        loading: true,
        error: undefined,
        empty: false,
      },
      expected: true,
    },
    {
      name: 'raw Escape closes an errored form',
      args: {
        input: '\u001B',
        key: {},
        loading: false,
        error: 'failed',
        empty: false,
      },
      expected: true,
    },
    {
      name: 'raw Escape closes an empty form',
      args: {
        input: '\u001B',
        key: {},
        loading: false,
        error: undefined,
        empty: true,
      },
      expected: true,
    },
    {
      name: 'Escape does not close an actionable list form',
      args: {
        input: '\u001B',
        key: {},
        loading: false,
        error: undefined,
        empty: false,
      },
      expected: false,
    },
    {
      name: 'Enter closes an empty picker only when its footer advertises it',
      args: {
        input: '\r',
        key: { return: true },
        loading: false,
        error: undefined,
        empty: true,
        closeEmptyOnEnter: true,
      },
      expected: true,
    },
    {
      name: 'Enter does not close an empty picker without the footer hint',
      args: {
        input: '\r',
        key: { return: true },
        loading: false,
        error: undefined,
        empty: true,
      },
      expected: false,
    },
  ])('$name', ({ args, expected }) => {
    expect(shouldCloseAsyncListFormOnInput(args)).toBe(expected);
  });
});

describe('CLI async list form buffered input', () => {
  it.each<{
    name: string;
    args: Parameters<typeof shouldBufferAsyncListFormInput>[0];
    expected: boolean;
  }>([
    {
      name: 'captures an ordinary key while loading',
      args: { input: '6', key: {}, loading: true },
      expected: true,
    },
    {
      name: 'captures a multi-digit key while loading',
      args: { input: '21', key: {}, loading: true },
      expected: true,
    },
    {
      name: 'ignores navigation keys',
      args: { input: '2', key: { downArrow: true }, loading: true },
      expected: false,
    },
    {
      name: 'ignores Enter',
      args: { input: '\r', key: { return: true }, loading: true },
      expected: false,
    },
    {
      name: 'ignores Escape',
      args: { input: '\u001B', key: { escape: true }, loading: true },
      expected: false,
    },
    {
      name: 'ignores modified keys',
      args: { input: 'c', key: { ctrl: true }, loading: true },
      expected: false,
    },
    {
      name: 'only buffers while loading',
      args: { input: '6', key: {}, loading: false },
      expected: false,
    },
  ])('$name', ({ args, expected }) => {
    expect(shouldBufferAsyncListFormInput(args)).toBe(expected);
  });
});

describe('Select render keys', () => {
  it('does not collapse object-valued items to the same React key', () => {
    const first = selectItemRenderKey(
      { value: { kind: 'chat' }, label: 'New chat' },
      0,
    );
    const second = selectItemRenderKey(
      { value: { kind: 'help' }, label: 'Help' },
      1,
    );

    expect(first).toBe('0:New chat');
    expect(second).toBe('1:Help');
    expect(first).not.toBe(second);
  });
});

describe('CLI Select visible range', () => {
  it.each<{
    name: string;
    args: Parameters<typeof visibleSelectRange>[0];
    expected: { start: number; end: number };
  }>([
    {
      name: 'keeps a contiguous window around the highlighted row',
      args: { itemCount: 8, highlight: 5, maxVisibleItems: 5 },
      expected: { start: 3, end: 8 },
    },
    {
      name: 'clamps the visible window at the list start',
      args: { itemCount: 8, highlight: 0, maxVisibleItems: 5 },
      expected: { start: 0, end: 5 },
    },
    {
      name: 'clamps the visible window at the list end',
      args: { itemCount: 8, highlight: 7, maxVisibleItems: 5 },
      expected: { start: 3, end: 8 },
    },
    {
      name: 'allows callers to reserve zero visible rows',
      args: { itemCount: 8, highlight: 3, maxVisibleItems: 0 },
      expected: { start: 0, end: 0 },
    },
  ])('$name', ({ args, expected }) => {
    expect(visibleSelectRange(args)).toEqual(expected);
  });
});

describe('CLI Select inline overflow', () => {
  it.each<{
    name: string;
    args: Parameters<typeof selectVisibleInlineOverflowText>[0];
    expected: string | undefined;
  }>([
    {
      name: 'summarizes choices hidden after the window',
      args: {
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: false,
        visibleItemCount: 3,
      },
      expected: '+3 more',
    },
    {
      name: 'summarizes choices hidden before the window',
      args: {
        hiddenBefore: 2,
        hiddenAfter: 0,
        showOverflow: false,
        visibleItemCount: 3,
      },
      expected: '+2 earlier',
    },
    {
      name: 'summarizes choices hidden on both sides',
      args: {
        hiddenBefore: 2,
        hiddenAfter: 4,
        showOverflow: false,
        visibleItemCount: 3,
      },
      expected: '+2 earlier, +4 more',
    },
    {
      name: 'defers to separate overflow rows when they are enabled',
      args: {
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: true,
        visibleItemCount: 3,
      },
      expected: undefined,
    },
    {
      name: 'suppresses inline overflow when there are no visible items',
      args: {
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: false,
        visibleItemCount: 0,
      },
      expected: undefined,
    },
    {
      name: 'shows inline overflow for any clipped visible window',
      args: {
        hiddenBefore: 0,
        hiddenAfter: 2,
        showOverflow: false,
        visibleItemCount: 3,
      },
      expected: '+2 more',
    },
  ])('$name', ({ args, expected }) => {
    expect(selectVisibleInlineOverflowText(args)).toBe(expected);
  });
});

describe('CLI Select disabled-row focus', () => {
  const items = [
    { value: 'gemini', label: 'Gemini', disabled: true },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'deepseek', label: 'DeepSeek', disabled: true },
  ];
  const enabledItems = [
    { value: 'gemini', label: 'Gemini' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
  ];

  it.each<{
    name: string;
    args: Parameters<typeof selectInitialHighlightIndex>[0];
    expected: number;
  }>([
    {
      name: 'starts on the active row when it is enabled',
      args: { activeValue: 'sonnet', items },
      expected: 1,
    },
    {
      name: 'starts on the first enabled row when the active row is disabled',
      args: { activeValue: 'deepseek', items },
      expected: 1,
    },
    {
      name: 'starts on the first enabled row when the requested initial row is disabled',
      args: { initialIndex: 3, items },
      expected: 1,
    },
  ])('$name', ({ args, expected }) => {
    expect(selectInitialHighlightIndex(args)).toBe(expected);
  });

  it.each<{
    name: string;
    args: Parameters<typeof nextSelectHighlightIndex>[0];
    expected: number;
  }>([
    {
      name: 'moves down past an enabled row',
      args: { direction: 1, highlight: 1, items },
      expected: 2,
    },
    {
      name: 'stops moving down at a disabled boundary row',
      args: { direction: 1, highlight: 2, items },
      expected: 2,
    },
    {
      name: 'stops moving up at a disabled boundary row',
      args: { direction: -1, highlight: 1, items },
      expected: 1,
    },
    {
      name: 'moves up to an enabled row',
      args: { direction: -1, highlight: 2, items },
      expected: 1,
    },
    {
      name: 'reports the disabled top row as a non-wrapping boundary',
      args: { direction: -1, highlight: 1, items, wrap: false },
      expected: 1,
    },
    {
      name: 'reports the disabled bottom row as a non-wrapping boundary',
      args: { direction: 1, highlight: 2, items, wrap: false },
      expected: 2,
    },
    {
      name: 'wraps upward from the top of an all-enabled list',
      args: { direction: -1, highlight: 0, items: enabledItems },
      expected: 2,
    },
    {
      name: 'wraps downward from the bottom of an all-enabled list',
      args: { direction: 1, highlight: 2, items: enabledItems },
      expected: 0,
    },
  ])('$name', ({ args, expected }) => {
    expect(nextSelectHighlightIndex(args)).toBe(expected);
  });
});

describe('CLI ModelListForm row budget', () => {
  it('uses compact slash forms before bordered content clips titles', () => {
    expect(COMPACT_FORM_MAX_ROWS).toBe(9);
    expect(isCompactFormRows(9)).toBe(true);
    expect(isCompactFormRows(10)).toBe(false);
  });

  it.each<{
    availableRows: number;
    expected: ReturnType<typeof modelSelectWindow>;
  }>([
    {
      availableRows: 6,
      expected: { maxVisibleItems: 1, showOverflow: false },
    },
    {
      availableRows: 7,
      expected: { maxVisibleItems: 1, showOverflow: false },
    },
    {
      availableRows: 8,
      expected: { maxVisibleItems: 2, showOverflow: false },
    },
    {
      availableRows: 12,
      expected: { maxVisibleItems: 4, showOverflow: true },
    },
  ])(
    'sizes the window for $availableRows available rows',
    ({ availableRows, expected }) => {
      expect(modelSelectWindow({ availableRows, itemCount: 8 })).toEqual(
        expected,
      );
    },
  );
});
