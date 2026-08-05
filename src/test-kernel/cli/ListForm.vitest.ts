import { describe, expect, it } from 'vitest';

import {
  listFormSelectWindow,
  listFormShortcutLabel,
  pendingListFormChoice,
} from '@cli/chat/tui/forms/_shared/ListForm';

describe('shared CLI list-form row budget', () => {
  it('derives chrome from the rows the form renders', () => {
    expect(
      listFormSelectWindow({
        availableRows: 12,
        itemCount: 10,
        hasDescription: true,
        selectMarginTop: 1,
      }),
    ).toEqual({ maxVisibleItems: 3, showOverflow: true });

    expect(
      listFormSelectWindow({
        availableRows: 10,
        itemCount: 10,
        hasDescription: true,
        detailRows: 1,
      }),
    ).toEqual({ maxVisibleItems: 1, showOverflow: true });
  });

  it('uses all available rows when the list fits', () => {
    expect(
      listFormSelectWindow({
        availableRows: 12,
        itemCount: 4,
        hasDescription: true,
        selectMarginTop: 1,
      }),
    ).toEqual({ maxVisibleItems: 4, showOverflow: false });
  });

  it('keeps the selected row instead of unaffordable overflow markers', () => {
    expect(
      listFormSelectWindow({
        availableRows: 7,
        itemCount: 8,
        hasDescription: true,
      }),
    ).toEqual({ maxVisibleItems: 1, showOverflow: false });
  });
});

describe('shared CLI list-form buffered selection', () => {
  const items = [
    { value: 'first', label: 'First' },
    { value: 'second', label: 'Second', disabled: true },
    { value: 'third', label: 'Third' },
  ];

  it('replays a valid hotkey after loading', () => {
    expect(pendingListFormChoice({ input: '3', items })).toBe('third');
  });

  it('ignores disabled and non-hotkey input', () => {
    expect(pendingListFormChoice({ input: '2', items })).toBeUndefined();
    expect(pendingListFormChoice({ input: '/', items })).toBeUndefined();
  });
});

describe('shared CLI list-form shortcut labels', () => {
  it('describes only keys that have rows', () => {
    expect(listFormShortcutLabel(1)).toBe('1/Enter');
    expect(listFormShortcutLabel(4)).toBe('1-4/Enter');
    expect(listFormShortcutLabel(12)).toBe('1-9/a-z/Enter');
  });
});
