// Local imports - shared stream identity
import type { StreamTabId } from '@shared/schemas';

export type ChildListValue =
  `stream:${string}` | `workflowPhase:${string}` | `workflowTask:${string}`;

export function childStreamListValue(streamId: StreamTabId): ChildListValue {
  return `stream:${streamId}`;
}

export function workflowPhaseListValue(entryId: string): ChildListValue {
  return `workflowPhase:${entryId}`;
}

export function workflowTaskListValue(entryId: string): ChildListValue {
  return `workflowTask:${entryId}`;
}

export function isWorkflowTaskListValue(
  value: ChildListValue | undefined,
): value is `workflowTask:${string}` {
  return value?.startsWith('workflowTask:') ?? false;
}

export function childListStreamId(
  value: ChildListValue | undefined,
): StreamTabId | undefined {
  return value?.startsWith('stream:')
    ? (value.slice('stream:'.length) as StreamTabId)
    : undefined;
}

export interface ChildListSelectionState {
  readonly focused: boolean;
  readonly selectedValue: ChildListValue | undefined;
}

type ChildListSelectionAction =
  | { readonly kind: 'blur' }
  | { readonly kind: 'focus'; readonly value?: ChildListValue }
  | { readonly kind: 'focusStream'; readonly streamId: StreamTabId }
  | { readonly kind: 'highlight'; readonly value: ChildListValue }
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
      return { ...state, focused: false };
    case 'focus':
      return {
        focused: true,
        selectedValue: state.selectedValue ?? action.value,
      };
    case 'focusStream':
      return {
        focused: false,
        selectedValue: childStreamListValue(action.streamId),
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
