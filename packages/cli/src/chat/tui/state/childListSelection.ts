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
}

type ChildListSelectionAction =
  | { readonly kind: 'blur' }
  | { readonly kind: 'focus'; readonly fallbackValue?: ChildListValue }
  | { readonly kind: 'focusStream'; readonly streamId: StreamTabId }
  | { readonly kind: 'highlight'; readonly value: ChildListValue }
  | { readonly kind: 'syncActiveStream'; readonly streamId: StreamTabId }
  | {
      readonly kind: 'reconcile';
      readonly activeStreamId: StreamTabId | undefined;
      readonly values: readonly ChildListValue[];
    };

export const INITIAL_CHILD_LIST_SELECTION: ChildListSelectionState = {
  focused: false,
  selectedValue: undefined,
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
  }
  return values.find((value) => childListStreamId(value) !== undefined);
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
        ...state,
        focused: true,
        selectedValue: state.selectedValue ?? action.fallbackValue,
      };
    case 'focusStream':
      return {
        focused: false,
        selectedValue: childStreamListValue(action.streamId),
      };
    case 'highlight':
      return { ...state, selectedValue: action.value };
    case 'syncActiveStream':
      return {
        ...state,
        selectedValue: childStreamListValue(action.streamId),
      };
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
