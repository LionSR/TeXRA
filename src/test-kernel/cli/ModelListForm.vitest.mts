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
} from '@cli/chat/tui/forms/_shared/selectWindow';
import {
  nextSelectHighlightIndex,
  selectInitialHighlightIndex,
  selectItemRenderKey,
  visibleSelectRange,
} from '@cli/chat/tui/ui/Select';
import {
  selectInlineOverflowText,
  selectVisibleInlineOverflowText,
} from '@cli/chat/tui/render/overflowText';

describe('CLI ModelListForm empty state', () => {
  it('uses a truthful description for empty and non-empty model lists', () => {
    expect(modelListDescription({ itemCount: 0, selectable: false })).toBe(
      'No model choices in this API mode.',
    );
    expect(modelListDescription({ itemCount: 0, selectable: true })).toBe(
      'No model choices in this API mode.',
    );
    expect(modelListDescription({ itemCount: 2, selectable: false })).toBe(
      'Available models. Finish the active response before switching models.',
    );
    expect(modelListDescription({ itemCount: 2, selectable: true })).toBe(
      'Choose the model for future turns.',
    );
  });
});

describe('CLI async list form close input', () => {
  it('treats normalized and raw Escape as close in non-actionable states', () => {
    expect(
      shouldCloseAsyncListFormOnInput({
        input: '',
        key: { escape: true },
        loading: true,
        error: undefined,
        empty: false,
      }),
    ).toBe(true);
    expect(
      shouldCloseAsyncListFormOnInput({
        input: '\u001B',
        key: {},
        loading: false,
        error: 'failed',
        empty: false,
      }),
    ).toBe(true);
    expect(
      shouldCloseAsyncListFormOnInput({
        input: '\u001B',
        key: {},
        loading: false,
        error: undefined,
        empty: true,
      }),
    ).toBe(true);
  });

  it('does not let Escape close an actionable list form', () => {
    expect(
      shouldCloseAsyncListFormOnInput({
        input: '\u001B',
        key: {},
        loading: false,
        error: undefined,
        empty: false,
      }),
    ).toBe(false);
  });
});

describe('CLI async list form buffered input', () => {
  it('captures ordinary keys while loading', () => {
    expect(
      shouldBufferAsyncListFormInput({
        input: '6',
        key: {},
        loading: true,
      }),
    ).toBe(true);
    expect(
      shouldBufferAsyncListFormInput({
        input: '21',
        key: {},
        loading: true,
      }),
    ).toBe(true);
  });

  it('ignores navigation, enter, escape, and modified keys', () => {
    expect(
      shouldBufferAsyncListFormInput({
        input: '2',
        key: { downArrow: true },
        loading: true,
      }),
    ).toBe(false);
    expect(
      shouldBufferAsyncListFormInput({
        input: '\r',
        key: { return: true },
        loading: true,
      }),
    ).toBe(false);
    expect(
      shouldBufferAsyncListFormInput({
        input: '\u001B',
        key: { escape: true },
        loading: true,
      }),
    ).toBe(false);
    expect(
      shouldBufferAsyncListFormInput({
        input: 'c',
        key: { ctrl: true },
        loading: true,
      }),
    ).toBe(false);
  });

  it('only buffers while loading', () => {
    expect(
      shouldBufferAsyncListFormInput({
        input: '6',
        key: {},
        loading: false,
      }),
    ).toBe(false);
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
  it('keeps a contiguous window around the highlighted row', () => {
    expect(
      visibleSelectRange({
        itemCount: 8,
        highlight: 5,
        maxVisibleItems: 5,
      }),
    ).toEqual({ start: 3, end: 8 });
  });

  it('clamps the visible window at list edges', () => {
    expect(
      visibleSelectRange({
        itemCount: 8,
        highlight: 0,
        maxVisibleItems: 5,
      }),
    ).toEqual({ start: 0, end: 5 });
    expect(
      visibleSelectRange({
        itemCount: 8,
        highlight: 7,
        maxVisibleItems: 5,
      }),
    ).toEqual({ start: 3, end: 8 });
  });

  it('allows callers to reserve zero visible rows', () => {
    expect(
      visibleSelectRange({
        itemCount: 8,
        highlight: 3,
        maxVisibleItems: 0,
      }),
    ).toEqual({ start: 0, end: 0 });
  });
});

describe('CLI Select inline overflow', () => {
  it('summarizes hidden choices when separate overflow rows are disabled', () => {
    expect(
      selectInlineOverflowText({
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: false,
      }),
    ).toBe('+3 more');
    expect(
      selectInlineOverflowText({
        hiddenBefore: 2,
        hiddenAfter: 0,
        showOverflow: false,
      }),
    ).toBe('+2 earlier');
    expect(
      selectInlineOverflowText({
        hiddenBefore: 2,
        hiddenAfter: 4,
        showOverflow: false,
      }),
    ).toBe('+2 earlier, +4 more');
  });

  it('defers to separate overflow rows when they are enabled', () => {
    expect(
      selectInlineOverflowText({
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: true,
      }),
    ).toBeUndefined();
  });

  it('shows inline overflow for any clipped visible window', () => {
    expect(
      selectVisibleInlineOverflowText({
        hiddenBefore: 0,
        hiddenAfter: 2,
        showOverflow: false,
        visibleItemCount: 3,
      }),
    ).toBe('+2 more');
  });
});

describe('CLI Select disabled-row focus', () => {
  const items = [
    { value: 'gemini', label: 'Gemini', disabled: true },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'deepseek', label: 'DeepSeek', disabled: true },
  ];

  it('starts on the active row when it is enabled', () => {
    expect(
      selectInitialHighlightIndex({
        activeValue: 'sonnet',
        items,
      }),
    ).toBe(1);
  });

  it('starts on the first enabled row when the active row is disabled', () => {
    expect(
      selectInitialHighlightIndex({
        activeValue: 'deepseek',
        items,
      }),
    ).toBe(1);
  });

  it('starts on the first enabled row when the requested initial row is disabled', () => {
    expect(
      selectInitialHighlightIndex({
        initialIndex: 3,
        items,
      }),
    ).toBe(1);
  });

  it('keeps arrow navigation directional around disabled rows', () => {
    expect(
      nextSelectHighlightIndex({
        direction: 1,
        highlight: 1,
        items,
      }),
    ).toBe(2);
    expect(
      nextSelectHighlightIndex({
        direction: 1,
        highlight: 2,
        items,
      }),
    ).toBe(2);
    expect(
      nextSelectHighlightIndex({
        direction: -1,
        highlight: 1,
        items,
      }),
    ).toBe(1);
    expect(
      nextSelectHighlightIndex({
        direction: -1,
        highlight: 2,
        items,
      }),
    ).toBe(1);
  });

  it('keeps wraparound navigation for all-enabled lists', () => {
    const enabledItems = [
      { value: 'gemini', label: 'Gemini' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
    ];

    expect(
      nextSelectHighlightIndex({
        direction: -1,
        highlight: 0,
        items: enabledItems,
      }),
    ).toBe(2);
    expect(
      nextSelectHighlightIndex({
        direction: 1,
        highlight: 2,
        items: enabledItems,
      }),
    ).toBe(0);
  });
});

describe('CLI ModelListForm row budget', () => {
  it('uses compact slash forms before bordered content clips titles', () => {
    expect(COMPACT_FORM_MAX_ROWS).toBe(9);
    expect(isCompactFormRows(9)).toBe(true);
    expect(isCompactFormRows(10)).toBe(false);
  });

  it('removes the row floor on short terminals', () => {
    expect(modelSelectWindow({ availableRows: 6, itemCount: 8 })).toEqual({
      maxVisibleItems: 1,
      showOverflow: false,
    });
    expect(modelSelectWindow({ availableRows: 7, itemCount: 8 })).toEqual({
      maxVisibleItems: 1,
      showOverflow: false,
    });
    expect(modelSelectWindow({ availableRows: 8, itemCount: 8 })).toEqual({
      maxVisibleItems: 2,
      showOverflow: false,
    });
  });

  it('spends overflow rows only when the budget can fit them', () => {
    expect(modelSelectWindow({ availableRows: 12, itemCount: 8 })).toEqual({
      maxVisibleItems: 4,
      showOverflow: true,
    });
  });
});
