// Local imports - shared stream identity
import type { StreamTabId } from '@shared/schemas';

export interface ChildListSelectionState {
  readonly focused: boolean;
  readonly selectedValue: StreamTabId | undefined;
}

type ChildListSelectionAction =
  | { readonly kind: 'blur' }
  | { readonly kind: 'focus'; readonly value?: StreamTabId }
  | { readonly kind: 'focusStream'; readonly streamId: StreamTabId }
  | { readonly kind: 'highlight'; readonly value: StreamTabId }
  | {
      readonly kind: 'syncActiveStream';
      readonly streamId: StreamTabId;
      readonly values: readonly StreamTabId[];
    }
  | {
      readonly kind: 'reconcile';
      readonly activeStreamId: StreamTabId | undefined;
      readonly values: readonly StreamTabId[];
    };

export const INITIAL_CHILD_LIST_SELECTION: ChildListSelectionState = {
  focused: false,
  selectedValue: undefined,
};

function resolveChildSelectionValue(
  values: readonly StreamTabId[],
  selectedValue: StreamTabId | undefined,
  activeStreamId: StreamTabId | undefined,
): StreamTabId | undefined {
  if (selectedValue && values.includes(selectedValue)) return selectedValue;
  if (activeStreamId)
    return values.includes(activeStreamId) ? activeStreamId : undefined;
  return values[0];
}

/** Apply one keyboard or child-lifecycle transition to child-list state. */
export function reduceChildListSelection(
  state: ChildListSelectionState,
  action: ChildListSelectionAction,
): ChildListSelectionState {
  switch (action.kind) {
    case 'blur':
      return { ...state, focused: false };
    case 'focus':
      return {
        focused: true,
        selectedValue: state.selectedValue ?? action.value,
      };
    case 'focusStream':
      return {
        focused: false,
        selectedValue: action.streamId,
      };
    case 'highlight':
      return action.value === state.selectedValue
        ? state
        : { ...state, selectedValue: action.value };
    case 'syncActiveStream': {
      const activeValue = resolveChildSelectionValue(
        action.values,
        undefined,
        action.streamId,
      );
      return activeValue === state.selectedValue
        ? state
        : { ...state, selectedValue: activeValue };
    }
    case 'reconcile': {
      if (action.values.length === 0) return state;
      const selectedValue = resolveChildSelectionValue(
        action.values,
        state.selectedValue,
        action.activeStreamId,
      );
      return selectedValue === state.selectedValue
        ? state
        : { ...state, selectedValue };
    }
  }
}
