import { describe, expect, it } from 'vitest';

import {
  childListStreamId,
  childStreamListValue,
  isWorkflowTaskListValue,
  workflowPhaseListValue,
  workflowTaskListValue,
  INITIAL_CHILD_LIST_SELECTION,
  reduceChildListSelection,
  type ChildListSelectionState,
  type ChildListValue,
} from '@cli/chat/tui/state/childListSelection';
import type { StreamTabId } from '@shared/schemas';

const main = 'main' as StreamTabId;
const strategy = 'strategy' as StreamTabId;
const analysis = 'analysis' as StreamTabId;
const mainValue = childStreamListValue(main);
const strategyValue = childStreamListValue(strategy);
const analysisValue = childStreamListValue(analysis);

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
  it('uses stable prefixed values for child rows', () => {
    expect(mainValue).toBe('stream:main');
    expect(childListStreamId(mainValue)).toBe(main);
    expect(workflowPhaseListValue('entry:phase')).toBe(
      'workflowPhase:entry:phase',
    );
    expect(workflowTaskListValue('entry:task')).toBe('workflowTask:entry:task');
    expect(isWorkflowTaskListValue(workflowTaskListValue('entry:task'))).toBe(
      true,
    );
    expect(isWorkflowTaskListValue(workflowPhaseListValue('entry:phase'))).toBe(
      false,
    );
    expect(isWorkflowTaskListValue(undefined)).toBe(false);
    expect(
      childListStreamId(workflowTaskListValue('entry:task')),
    ).toBeUndefined();
    expect(childListStreamId(undefined)).toBeUndefined();
  });

  it('preserves a selection across list focus and row reordering', () => {
    let state = reconcileSelection(
      INITIAL_CHILD_LIST_SELECTION,
      [mainValue, strategyValue, analysisValue],
      main,
    );
    state = reduceChildListSelection(state, { kind: 'focus' });
    state = reduceChildListSelection(state, {
      kind: 'highlight',
      value: analysisValue,
    });
    state = reconcileSelection(
      state,
      [strategyValue, analysisValue, mainValue],
      main,
    );

    expect(state).toEqual({
      focused: true,
      selectedValue: analysisValue,
    });
  });

  it('preserves selection while hidden and restores it when rows return', () => {
    const selected: ChildListSelectionState = {
      focused: true,
      selectedValue: strategyValue,
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
      { focused: true, selectedValue: strategyValue },
      {
        kind: 'syncActiveStream',
        streamId: main,
        values: [mainValue, strategyValue],
      },
    );

    expect(state).toEqual({
      focused: true,
      selectedValue: mainValue,
    });
  });

  it('preserves identity when active-stream sync keeps the same row', () => {
    const hidden: ChildListSelectionState = {
      focused: true,
      selectedValue: mainValue,
    };
    const state = reduceChildListSelection(hidden, {
      kind: 'syncActiveStream',
      streamId: main,
      values: [mainValue, strategyValue],
    });

    expect(state).toBe(hidden);
  });

  it('clears a stale row when the active stream is not in the projected list', () => {
    const state = reduceChildListSelection(
      { focused: true, selectedValue: strategyValue },
      {
        kind: 'syncActiveStream',
        streamId: main,
        values: [analysisValue],
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
        selectedValue: childStreamListValue('gone' as StreamTabId),
      },
      [analysisValue, mainValue],
      main,
    );
    expect(state.selectedValue).toBe(mainValue);

    state = reconcileSelection(
      state,
      [analysisValue, strategyValue],
      undefined,
    );
    expect(state.selectedValue).toBe(analysisValue);
  });

  it('does not preselect a row while the active root is absent from the list', () => {
    let state = reconcileSelection(
      INITIAL_CHILD_LIST_SELECTION,
      [analysisValue],
      main,
    );
    expect(state.selectedValue).toBeUndefined();

    state = reduceChildListSelection(state, {
      kind: 'focus',
      value: analysisValue,
    });
    expect(state).toEqual({
      focused: true,
      selectedValue: analysisValue,
    });
  });

  it('returns input after a stream is focused', () => {
    const state = reduceChildListSelection(
      { focused: true, selectedValue: analysisValue },
      { kind: 'focusStream', streamId: strategy },
    );
    expect(state).toEqual({
      focused: false,
      selectedValue: strategyValue,
    });
  });

  it('changes only the highlighted row without opening a detail block', () => {
    let state = reduceChildListSelection(
      { focused: false, selectedValue: mainValue },
      { kind: 'focus' },
    );
    state = reduceChildListSelection(state, {
      kind: 'highlight',
      value: strategyValue,
    });

    expect(state).toEqual({
      focused: true,
      selectedValue: strategyValue,
    });
  });
});
