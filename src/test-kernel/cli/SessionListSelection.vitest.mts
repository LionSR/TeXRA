import { describe, expect, it } from 'vitest';

import {
  INITIAL_SESSION_LIST_SELECTION,
  reduceSessionListSelection,
  type SessionListSelectionState,
} from '@cli/chat/tui/state/sessionListSelection';
import type { StreamView } from '@cli/chat/tui/state/streamViews';
import type { StreamTabId } from '@shared/schemas';

function session(id: string, active = false): StreamView {
  return {
    id: id as StreamTabId,
    label: id,
    slice: undefined,
    active,
  };
}

function reconcileSelection(
  state: SessionListSelectionState,
  sessions: readonly StreamView[],
  activeStreamId: StreamTabId | undefined,
): SessionListSelectionState {
  return reduceSessionListSelection(state, {
    kind: 'reconcile',
    activeStreamId,
    sessions,
  });
}

describe('CLI session list selection', () => {
  it('preserves selection by stream id across focus changes', () => {
    const main = 'main' as StreamTabId;
    const strategy = 'strategy' as StreamTabId;
    let state = reconcileSelection(
      INITIAL_SESSION_LIST_SELECTION,
      [session('main', true), session('strategy')],
      main,
    );

    state = reduceSessionListSelection(state, { kind: 'focus' });
    state = reduceSessionListSelection(state, {
      kind: 'highlight',
      streamId: strategy,
    });
    state = reduceSessionListSelection(state, { kind: 'blur' });
    state = reduceSessionListSelection(state, { kind: 'focus' });

    expect(state).toEqual({
      focused: true,
      selectedStreamId: strategy,
    });
  });

  it('keeps selection through reordering while its stream remains present', () => {
    const main = 'main' as StreamTabId;
    const strategy = 'strategy' as StreamTabId;
    const state = reconcileSelection(
      { focused: true, selectedStreamId: strategy },
      [session('review'), session('main', true), session('strategy')],
      main,
    );

    expect(state.selectedStreamId).toBe(strategy);
  });

  it('preserves selection while the session list is hidden', () => {
    const main = 'main' as StreamTabId;
    const strategy = 'strategy' as StreamTabId;
    const selected: SessionListSelectionState = {
      focused: false,
      selectedStreamId: strategy,
    };

    const hidden = reconcileSelection(selected, [], main);
    const restored = reconcileSelection(
      hidden,
      [session('main', true), session('strategy')],
      main,
    );

    expect(hidden).toBe(selected);
    expect(restored.selectedStreamId).toBe(strategy);
  });

  it('falls back after a hidden selected session disappears', () => {
    const main = 'main' as StreamTabId;
    const strategy = 'strategy' as StreamTabId;
    const selected: SessionListSelectionState = {
      focused: false,
      selectedStreamId: strategy,
    };

    const hidden = reconcileSelection(selected, [], main);
    const restored = reconcileSelection(
      hidden,
      [session('main', true), session('review')],
      main,
    );

    expect(hidden).toBe(selected);
    expect(restored.selectedStreamId).toBe(main);
  });

  it('falls back to the active session, then the first available session', () => {
    const main = 'main' as StreamTabId;
    const strategy = 'strategy' as StreamTabId;
    let state = reconcileSelection(
      { focused: true, selectedStreamId: strategy },
      [session('review'), session('main', true)],
      main,
    );
    expect(state.selectedStreamId).toBe(main);

    state = reconcileSelection(
      state,
      [session('review'), session('strategy')],
      undefined,
    );
    expect(state.selectedStreamId).toBe('review');
  });
});
