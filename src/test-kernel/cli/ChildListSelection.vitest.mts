import { describe, expect, it } from 'vitest';

import {
  childListProcessId,
  childListStreamId,
  childProcessListValue,
  childStreamListValue,
  INITIAL_CHILD_LIST_SELECTION,
  reduceChildListSelection,
  type ChildListSelectionState,
  type ChildListValue,
} from '@cli/chat/tui/state/childListSelection';
import type { StreamTabId } from '@shared/schemas';

const main = 'main' as StreamTabId;
const strategy = 'strategy' as StreamTabId;
const mainValue = childStreamListValue(main);
const strategyValue = childStreamListValue(strategy);
const processValue = childProcessListValue('latexmk-1');

function reconcileSelection(
  state: ChildListSelectionState,
  values: readonly ChildListValue[],
  activeStreamId: StreamTabId | undefined,
): ChildListSelectionState {
  return reduceChildListSelection(state, {
    kind: 'reconcile',
    activeStreamId,
    values,
  });
}

describe('CLI child list selection', () => {
  it('uses stable prefixed values for heterogeneous rows', () => {
    expect(mainValue).toBe('stream:main');
    expect(processValue).toBe('process:latexmk-1');
    expect(childListStreamId(mainValue)).toBe(main);
    expect(childListStreamId(processValue)).toBeUndefined();
    expect(childListProcessId(processValue)).toBe('latexmk-1');
    expect(childListProcessId(mainValue)).toBeUndefined();
  });

  it('preserves a process selection across list focus and row reordering', () => {
    let state = reconcileSelection(
      INITIAL_CHILD_LIST_SELECTION,
      [mainValue, strategyValue, processValue],
      main,
    );
    state = reduceChildListSelection(state, { kind: 'focus' });
    state = reduceChildListSelection(state, {
      kind: 'highlight',
      value: processValue,
    });
    state = reconcileSelection(
      state,
      [strategyValue, processValue, mainValue],
      main,
    );

    expect(state).toEqual({
      focused: true,
      selectedValue: processValue,
      rowExpanded: false,
    });
  });

  it('preserves selection while hidden and restores it when rows return', () => {
    const selected: ChildListSelectionState = {
      focused: true,
      selectedValue: strategyValue,
      rowExpanded: false,
    };
    const hidden = reconcileSelection(selected, [], main);
    const restored = reconcileSelection(
      hidden,
      [mainValue, strategyValue],
      main,
    );

    expect(hidden).toBe(selected);
    expect(restored.selectedValue).toBe(strategyValue);
  });

  it('selects the owner when lifecycle completion changes the active stream', () => {
    const state = reduceChildListSelection(
      { focused: true, selectedValue: strategyValue, rowExpanded: false },
      {
        kind: 'syncActiveStream',
        streamId: main,
        values: [mainValue, strategyValue],
      },
    );

    expect(state).toEqual({
      focused: true,
      selectedValue: mainValue,
      rowExpanded: false,
    });
  });

  it('clears a stale row when the active stream is not in the projected list', () => {
    const state = reduceChildListSelection(
      { focused: true, selectedValue: strategyValue, rowExpanded: false },
      {
        kind: 'syncActiveStream',
        streamId: main,
        values: [processValue],
      },
    );

    expect(state).toEqual({
      focused: true,
      selectedValue: undefined,
      rowExpanded: false,
    });
  });

  it('collapses the file-detail panel when the highlight moves to a new row', () => {
    const expanded: ChildListSelectionState = {
      focused: true,
      selectedValue: mainValue,
      rowExpanded: true,
    };
    expect(
      reduceChildListSelection(expanded, { kind: 'toggleRowExpand' }),
    ).toEqual({ focused: true, selectedValue: mainValue, rowExpanded: false });
    expect(
      reduceChildListSelection(expanded, {
        kind: 'highlight',
        value: strategyValue,
      }),
    ).toEqual({
      focused: true,
      selectedValue: strategyValue,
      rowExpanded: false,
    });
  });

  it('falls back to the active stream and then the first row', () => {
    let state = reconcileSelection(
      {
        focused: true,
        selectedValue: childProcessListValue('gone'),
        rowExpanded: false,
      },
      [processValue, mainValue],
      main,
    );
    expect(state.selectedValue).toBe(mainValue);

    state = reconcileSelection(state, [processValue, strategyValue], undefined);
    expect(state.selectedValue).toBe(processValue);
  });

  it('does not preselect a process while the active root is absent from the list', () => {
    let state = reconcileSelection(
      INITIAL_CHILD_LIST_SELECTION,
      [processValue],
      main,
    );
    expect(state.selectedValue).toBeUndefined();

    state = reduceChildListSelection(state, {
      kind: 'focus',
      value: processValue,
    });
    expect(state).toEqual({
      focused: true,
      selectedValue: processValue,
      rowExpanded: false,
    });
  });

  it('returns input after a stream is focused', () => {
    const state = reduceChildListSelection(
      { focused: true, selectedValue: processValue, rowExpanded: true },
      { kind: 'focusStream', streamId: strategy },
    );
    expect(state).toEqual({
      focused: false,
      selectedValue: strategyValue,
      rowExpanded: false,
    });
  });
});
