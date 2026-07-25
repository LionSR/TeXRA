// Local imports - shared stream identity
import type { StreamTabId } from '@shared/schemas';

/**
 * A row identity in the child list. `stream:` rows are the selectable ones;
 * `phase:` rows are the workflow-phase dividers the focused-run list inserts,
 * which are `disabled` `Select` items and therefore never selected, never
 * highlighted and never navigated onto. They exist only inside `SubagentList`'s
 * own item list — the caller's `values` stay stream-only, so selection
 * reconciliation can never fall back onto a divider.
 */
export type ChildListValue = `stream:${string}` | `phase:${string}`;

export function childStreamListValue(streamId: StreamTabId): ChildListValue {
  return `stream:${streamId}`;
}

export function childPhaseListValue(phase: string): ChildListValue {
  return `phase:${phase}`;
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
