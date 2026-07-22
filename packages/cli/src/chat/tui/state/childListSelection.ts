// Local imports - shared stream identity
import type { StreamTabId } from '@shared/schemas';

export type ChildListValue = `stream:${string}` | `process:${string}`;

export function childStreamListValue(streamId: StreamTabId): ChildListValue {
  return `stream:${streamId}`;
}

export function childProcessListValue(executionId: string): ChildListValue {
  return `process:${executionId}`;
}

export function childListStreamId(
  value: ChildListValue | undefined,
): StreamTabId | undefined {
  return value?.startsWith('stream:')
    ? (value.slice('stream:'.length) as StreamTabId)
    : undefined;
}

export function childListProcessId(
  value: ChildListValue | undefined,
): string | undefined {
  return value?.startsWith('process:')
    ? value.slice('process:'.length)
    : undefined;
}

export interface ChildListSelectionState {
  readonly focused: boolean;
  readonly selectedValue: ChildListValue | undefined;
  /** Stream details open automatically on selection and remain
   *  user-toggleable while the child list owns the keyboard. */
  readonly detailsVisible: boolean;
}

type ChildListSelectionAction =
  | { readonly kind: 'blur' }
  | { readonly kind: 'focus'; readonly value?: ChildListValue }
  | { readonly kind: 'focusStream'; readonly streamId: StreamTabId }
  | { readonly kind: 'highlight'; readonly value: ChildListValue }
  | { readonly kind: 'toggleDetails' }
  | {
      readonly kind: 'syncActiveStream';
      readonly streamId: StreamTabId;
      readonly values: readonly ChildListValue[];
    }
  | {
      readonly kind: 'reconcile';
      readonly activeStreamId: StreamTabId | undefined;
      readonly values: readonly ChildListValue[];
    };

export const INITIAL_CHILD_LIST_SELECTION: ChildListSelectionState = {
  focused: false,
  selectedValue: undefined,
  detailsVisible: false,
};

function resolveChildSelectionValue(
  values: readonly ChildListValue[],
  selectedValue: ChildListValue | undefined,
  activeStreamId: StreamTabId | undefined,
): ChildListValue | undefined {
  if (selectedValue && values.includes(selectedValue)) return selectedValue;
  if (activeStreamId) {
    const activeValue = childStreamListValue(activeStreamId);
    if (values.includes(activeValue)) return activeValue;
    return undefined;
  }
  return values[0];
}

/** Apply one keyboard or child-lifecycle transition to child-list state. */
export function reduceChildListSelection(
  state: ChildListSelectionState,
  action: ChildListSelectionAction,
): ChildListSelectionState {
  switch (action.kind) {
    case 'blur':
      return { ...state, focused: false, detailsVisible: false };
    case 'focus': {
      const selectedValue = state.selectedValue ?? action.value;
      return {
        focused: true,
        selectedValue,
        detailsVisible: childListStreamId(selectedValue) !== undefined,
      };
    }
    case 'focusStream':
      return {
        focused: false,
        selectedValue: childStreamListValue(action.streamId),
        detailsVisible: false,
      };
    case 'highlight':
      return action.value === state.selectedValue
        ? state
        : {
            ...state,
            selectedValue: action.value,
            detailsVisible: childListStreamId(action.value) !== undefined,
          };
    case 'toggleDetails':
      return state.focused
        ? { ...state, detailsVisible: !state.detailsVisible }
        : state;
    case 'syncActiveStream': {
      const activeValue = resolveChildSelectionValue(
        action.values,
        undefined,
        action.streamId,
      );
      return {
        ...state,
        selectedValue: activeValue,
        detailsVisible:
          state.focused && childListStreamId(activeValue) !== undefined,
      };
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
        : {
            ...state,
            selectedValue,
            detailsVisible:
              state.focused && childListStreamId(selectedValue) !== undefined,
          };
    }
  }
}
