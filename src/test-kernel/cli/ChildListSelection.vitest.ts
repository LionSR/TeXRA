import { describe, expect, it } from 'vitest';

import {
  INITIAL_CHILD_LIST_SELECTION,
  reduceChildListSelection,
  type ChildListSelectionState,
} from '@cli/chat/tui/state/childListSelection';
import type { RunId } from '@shared/schemas';

const main = 'main' as RunId;
const strategy = 'strategy' as RunId;
const analysis = 'analysis' as RunId;

function reconcileSelection(
  state: ChildListSelectionState,
  values: readonly RunId[],
  activeRunId: RunId | undefined,
): ChildListSelectionState {
  return reduceChildListSelection(state, {
    kind: 'reconcile',
    activeRunId,
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
        kind: 'syncActiveRun',
        runId: main,
        values: [main, strategy],
      },
    );

    expect(state).toEqual({
      focused: true,
      selectedValue: main,
    });
  });

  it('clears a stale row when the active stream is not in the projected list', () => {
    const state = reduceChildListSelection(
      { focused: true, selectedValue: strategy },
      {
        kind: 'syncActiveRun',
        runId: main,
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
        selectedValue: 'gone' as RunId,
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
});
