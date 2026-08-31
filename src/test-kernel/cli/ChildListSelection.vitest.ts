import { describe, expect, it } from 'vitest';

import {
  INITIAL_CHILD_LIST_SELECTION,
  reduceChildListSelection,
  type ChildListSelectionState,
} from '@cli/chat/tui/state/childListSelection';
import type { StreamTabId } from '@shared/schemas';

const main = 'main' as StreamTabId;
const strategy = 'strategy' as StreamTabId;
const analysis = 'analysis' as StreamTabId;

function reconcileSelection(
  state: ChildListSelectionState,
  values: readonly StreamTabId[],
  activeStreamId: StreamTabId | undefined,
): ChildListSelectionState {
  return reduceChildListSelection(state, {
    kind: 'reconcile',
    activeStreamId,
    values,
  });
}

describe('CLI child list selection', () => {
  it('preserves a selection across list focus and row reordering', () => {
    let state = reconcileSelection(
      INITIAL_CHILD_LIST_SELECTION,
      [main, strategy, analysis],
      main,
    );
    state = reduceChildListSelection(state, { kind: 'focus' });
    state = reduceChildListSelection(state, {
      kind: 'highlight',
      value: analysis,
    });
    state = reconcileSelection(state, [strategy, analysis, main], main);

    expect(state).toEqual({
      focused: true,
      selectedValue: analysis,
    });
  });

  it('preserves selection while hidden and restores it when rows return', () => {
    const selected: ChildListSelectionState = {
      focused: true,
      selectedValue: strategy,
    };
    const hidden = reconcileSelection(selected, [], main);
    const restored = reconcileSelection(hidden, [main, strategy], main);

    expect(hidden).toBe(selected);
    expect(restored.selectedValue).toBe(strategy);
  });

  it('selects the owner when lifecycle completion changes the active stream', () => {
    const state = reduceChildListSelection(
      { focused: true, selectedValue: strategy },
      {
        kind: 'syncActiveStream',
        streamId: main,
        values: [main, strategy],
      },
    );

    expect(state).toEqual({
      focused: true,
      selectedValue: main,
    });
  });

  it('preserves identity when active-stream sync keeps the same row', () => {
    const hidden: ChildListSelectionState = {
      focused: true,
      selectedValue: main,
    };
    const state = reduceChildListSelection(hidden, {
      kind: 'syncActiveStream',
      streamId: main,
      values: [main, strategy],
    });

    expect(state).toBe(hidden);
  });

  it('clears a stale row when the active stream is not in the projected list', () => {
    const state = reduceChildListSelection(
      { focused: true, selectedValue: strategy },
      {
        kind: 'syncActiveStream',
        streamId: main,
        values: [analysis],
      },
    );

    expect(state).toEqual({
      focused: true,
      selectedValue: undefined,
    });
  });

  it('falls back to the active stream and then the first row', () => {
    let state = reconcileSelection(
      {
        focused: true,
        selectedValue: 'gone' as StreamTabId,
      },
      [analysis, main],
      main,
    );
    expect(state.selectedValue).toBe(main);

    state = reconcileSelection(state, [analysis, strategy], undefined);
    expect(state.selectedValue).toBe(analysis);
  });

  it('does not preselect a row while the active root is absent from the list', () => {
    let state = reconcileSelection(
      INITIAL_CHILD_LIST_SELECTION,
      [analysis],
      main,
    );
    expect(state.selectedValue).toBeUndefined();

    state = reduceChildListSelection(state, {
      kind: 'focus',
      value: analysis,
    });
    expect(state).toEqual({
      focused: true,
      selectedValue: analysis,
    });
  });

  it('returns input after a stream is focused', () => {
    const state = reduceChildListSelection(
      { focused: true, selectedValue: analysis },
      { kind: 'focusStream', streamId: strategy },
    );
    expect(state).toEqual({
      focused: false,
      selectedValue: strategy,
    });
  });

  it('changes only the highlighted row without opening a detail block', () => {
    let state = reduceChildListSelection(
      { focused: false, selectedValue: main },
      { kind: 'focus' },
    );
    state = reduceChildListSelection(state, {
      kind: 'highlight',
      value: strategy,
    });

    expect(state).toEqual({
      focused: true,
      selectedValue: strategy,
    });
  });
});
