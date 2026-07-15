// Local imports - shared stream identity
import type { StreamTabId } from '@shared/schemas';

// Local imports - TUI state
import type { StreamView } from './streamViews';

export interface SessionListSelectionState {
  readonly focused: boolean;
  readonly selectedStreamId: StreamTabId | undefined;
}

type SessionListSelectionAction =
  | { readonly kind: 'blur' }
  | { readonly kind: 'focus' }
  | { readonly kind: 'focusStream'; readonly streamId: StreamTabId }
  | { readonly kind: 'highlight'; readonly streamId: StreamTabId }
  | {
      readonly kind: 'reconcile';
      readonly activeStreamId: StreamTabId | undefined;
      readonly sessions: readonly StreamView[];
    };

export const INITIAL_SESSION_LIST_SELECTION: SessionListSelectionState = {
  focused: false,
  selectedStreamId: undefined,
};

function resolveSessionSelectionId(
  sessions: readonly StreamView[],
  selectedStreamId: StreamTabId | undefined,
  activeStreamId: StreamTabId | undefined,
): StreamTabId | undefined {
  if (sessions.some((session) => session.id === selectedStreamId)) {
    return selectedStreamId;
  }
  if (sessions.some((session) => session.id === activeStreamId)) {
    return activeStreamId;
  }
  return sessions[0]?.id;
}

/** Apply one keyboard or stream-lifecycle transition to session-list state. */
export function reduceSessionListSelection(
  state: SessionListSelectionState,
  action: SessionListSelectionAction,
): SessionListSelectionState {
  switch (action.kind) {
    case 'blur':
      return { ...state, focused: false };
    case 'focus':
      return { ...state, focused: true };
    case 'focusStream':
      return {
        focused: false,
        selectedStreamId: action.streamId,
      };
    case 'highlight':
      return { ...state, selectedStreamId: action.streamId };
    case 'reconcile': {
      if (action.sessions.length === 0) return state;
      const selectedStreamId = resolveSessionSelectionId(
        action.sessions,
        state.selectedStreamId,
        action.activeStreamId,
      );
      return selectedStreamId === state.selectedStreamId
        ? state
        : { ...state, selectedStreamId };
    }
  }
}
