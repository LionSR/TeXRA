// Local imports - shared stream identity
import type { RunId } from '@shared/schemas';

export interface ChildListSelectionState {
  readonly focused: boolean;
  readonly selectedValue: RunId | undefined;
}

type ChildListSelectionAction =
  | { readonly kind: 'blur' }
  | { readonly kind: 'focus'; readonly value?: RunId }
  | { readonly kind: 'focusRun'; readonly runId: RunId }
  | { readonly kind: 'highlight'; readonly value: RunId }
  | {
      readonly kind: 'syncActiveRun';
      readonly runId: RunId;
      readonly values: readonly RunId[];
    }
  | {
      readonly kind: 'reconcile';
      readonly activeRunId: RunId | undefined;
      readonly values: readonly RunId[];
    };

export const INITIAL_CHILD_LIST_SELECTION: ChildListSelectionState = {
  focused: false,
  selectedValue: undefined,
};

function resolveChildSelectionValue(
  values: readonly RunId[],
  selectedValue: RunId | undefined,
  activeRunId: RunId | undefined,
): RunId | undefined {
  if (selectedValue && values.includes(selectedValue)) return selectedValue;
  if (activeRunId)
    return values.includes(activeRunId) ? activeRunId : undefined;
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
    case 'focusRun':
      return {
        focused: false,
        selectedValue: action.runId,
      };
    case 'highlight':
      return action.value === state.selectedValue
        ? state
        : { ...state, selectedValue: action.value };
    case 'syncActiveRun': {
      const activeValue = resolveChildSelectionValue(
        action.values,
        undefined,
        action.runId,
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
        action.activeRunId,
      );
      return selectedValue === state.selectedValue
        ? state
        : { ...state, selectedValue };
    }
  }
}
