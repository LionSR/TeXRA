import { Box, Text } from 'ink';
import { useEffect, useRef, type ReactNode } from 'react';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import {
  Select,
  selectIndexForHotkeyInput,
  type SelectItem,
} from '@cli/tui/ui/Select';

import {
  computeSelectWindowSize,
  isCompactFormRows,
  type SelectWindowSize,
} from '@cli/tui/selectWindow';
import {
  CompactFormKeyHints,
  FormFrame,
  renderAsyncListFormTransient,
} from './FormFrame';
import { useAsyncListForm } from './useAsyncListForm';

const LIST_FORM_FRAME_ROWS = 3;
const LIST_FORM_FOOTER_ROWS = 2;

export function listFormSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
  readonly hasDescription?: boolean;
  readonly detailRows?: number;
  readonly selectMarginTop?: number;
}): SelectWindowSize {
  return computeSelectWindowSize({
    availableRows: args.availableRows,
    itemCount: args.itemCount,
    chromeRows:
      LIST_FORM_FRAME_ROWS +
      LIST_FORM_FOOTER_ROWS +
      (args.hasDescription ? 1 : 0) +
      Math.max(0, args.detailRows ?? 0) +
      Math.max(0, args.selectMarginTop ?? 0),
  });
}

export interface ListFormProps<T> {
  readonly title: string;
  readonly compactTitle?: string;
  readonly availableRows?: number;
  readonly items: ReadonlyArray<SelectItem<T>>;
  readonly activeValue?: T;
  readonly description?: ReactNode;
  readonly detail?: ReactNode;
  readonly detailRows?: number;
  readonly compactDetail?: ReactNode;
  readonly compactVisibleItems?: number;
  readonly emptyMessage?: string;
  readonly emptyShowCloseHint?: boolean;
  readonly selectMarginTop?: number;
  readonly action: string;
  readonly escapeAction?: string;
  readonly onSelect: (value: T) => void;
  readonly onCancel: () => void;
}

/** Common list-picker layout, geometry, compact mode, and key vocabulary. */
export function ListForm<T>(props: ListFormProps<T>): React.JSX.Element {
  if (props.items.length === 0 && props.emptyMessage !== undefined) {
    return (
      <FormFrame
        color={COLOR_WARNING}
        title={props.title}
        showCloseHint={props.emptyShowCloseHint}
      >
        <Text>{props.emptyMessage}</Text>
        {props.detail}
      </FormFrame>
    );
  }

  const shortcut = listFormShortcutLabel(props.items.length);

  if (isCompactFormRows(props.availableRows)) {
    return (
      <FormFrame
        title={props.compactTitle ?? props.title}
        showCloseHint={false}
      >
        {props.compactDetail}
        <Select
          items={props.items}
          activeValue={props.activeValue}
          maxVisibleItems={Math.min(
            props.items.length,
            Math.max(1, props.compactVisibleItems ?? 1),
          )}
          showOverflow={false}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
        <CompactFormKeyHints
          primary={{ key: shortcut, action: props.action }}
          escapeAction={props.escapeAction}
        />
      </FormFrame>
    );
  }

  const selectWindow = listFormSelectWindow({
    availableRows: props.availableRows,
    itemCount: props.items.length,
    hasDescription: props.description !== undefined,
    detailRows: props.detailRows,
    selectMarginTop: props.selectMarginTop,
  });
  return (
    <FormFrame title={props.title} showCloseHint={false}>
      {props.description}
      {props.detail}
      <Box
        flexDirection="column"
        marginTop={Math.max(0, props.selectMarginTop ?? 0)}
      >
        <Select
          items={props.items}
          activeValue={props.activeValue}
          maxVisibleItems={selectWindow.maxVisibleItems}
          showOverflow={selectWindow.showOverflow}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: shortcut, action: props.action },
            { key: 'Esc', action: props.escapeAction ?? 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}

export function listFormShortcutLabel(itemCount: number): string {
  if (itemCount <= 0) return 'Enter';
  if (itemCount === 1) return '1/Enter';
  if (itemCount <= 9) return `1-${itemCount}/Enter`;
  return '1-9/a-z/Enter';
}

function usePendingListFormSelection<T>(args: {
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly pendingInput: string | undefined;
  readonly clearPendingInput: () => void;
  readonly items: ReadonlyArray<SelectItem<T>>;
  readonly enabled?: boolean;
  readonly onSelect: (value: T) => void;
}): void {
  const appliedInput = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      args.loading ||
      args.error !== undefined ||
      args.enabled === false ||
      !args.pendingInput ||
      appliedInput.current === args.pendingInput
    ) {
      return;
    }
    appliedInput.current = args.pendingInput;
    args.clearPendingInput();
    const value = pendingListFormChoice({
      input: args.pendingInput,
      items: args.items,
    });
    if (value !== undefined) args.onSelect(value);
  }, [args]);
}

export function pendingListFormChoice<T>(args: {
  readonly input: string;
  readonly items: ReadonlyArray<SelectItem<T>>;
}): T | undefined {
  const index = selectIndexForHotkeyInput(args.input);
  const choice = index == null ? undefined : args.items[index];
  return choice?.disabled ? undefined : choice?.value;
}

interface AsyncListFormControls<TData> {
  readonly data: TData;
  readonly setData: (next: TData) => void;
  /** Re-run the loader, keeping the current data on screen until it returns. */
  readonly reload: () => void;
}

export interface AsyncPickerForm<TData, TValue> {
  readonly data: TData | undefined;
  readonly items: ReadonlyArray<SelectItem<TValue>>;
  /** Apply a selection: the caller's handler, or a close for a read-only list. */
  readonly select: (value: TValue) => void;
  /** Loading / error frame to return before the form's own layout, else null. */
  readonly transient: React.JSX.Element | null;
}

/**
 * The async lifecycle every `/`-form picker runs: load once, buffer keystrokes
 * typed before the list mounts, render the loading/error frame, and turn a
 * selection into the caller's handler (or a close, for a read-only list).
 * Forms whose layout is the plain picker use {@link AsyncListForm}; `/agent`
 * and `/model` render their own sections on top of this hook.
 */
export function useAsyncPickerForm<TData, TValue>(args: {
  readonly title: string;
  readonly loadingLabel: string;
  readonly showTransientCloseHint?: boolean;
  readonly load: () => Promise<TData>;
  readonly isEmpty?: (data: TData) => boolean;
  readonly closeEmptyOnEnter?: boolean;
  readonly items: (data: TData) => ReadonlyArray<SelectItem<TValue>>;
  /** `false` renders a read-only list where selecting closes the form. */
  readonly selectable?: boolean;
  readonly onSelect?: (
    value: TValue,
    controls: AsyncListFormControls<TData>,
  ) => void;
  readonly onClose: () => void;
}): AsyncPickerForm<TData, TValue> {
  const {
    data,
    loading,
    error,
    pendingInput,
    clearPendingInput,
    setData,
    reload,
  } = useAsyncListForm<TData>({
    load: args.load,
    onClose: args.onClose,
    isEmpty: args.isEmpty,
    closeEmptyOnEnter: args.closeEmptyOnEnter,
  });
  const selectable = args.selectable !== false;
  const items = data === undefined ? [] : args.items(data);
  const select = (value: TValue): void => {
    if (!selectable) {
      args.onClose();
      return;
    }
    if (data !== undefined) args.onSelect?.(value, { data, setData, reload });
  };
  usePendingListFormSelection({
    loading,
    error,
    pendingInput,
    clearPendingInput,
    items,
    enabled: selectable,
    onSelect: select,
  });

  return {
    data,
    items,
    select,
    transient: renderAsyncListFormTransient({
      loading,
      error,
      title: args.title,
      loadingLabel: args.loadingLabel,
      showCloseHint: args.showTransientCloseHint,
    }),
  };
}

export interface AsyncListFormProps<TData, TValue> extends Omit<
  ListFormProps<TValue>,
  'items' | 'onSelect'
> {
  readonly loadingLabel: string;
  readonly load: () => Promise<TData>;
  readonly items: (data: TData) => ReadonlyArray<SelectItem<TValue>>;
  readonly isEmpty?: (data: TData) => boolean;
  readonly showTransientCloseHint?: boolean;
  readonly descriptionFor?: (data: TData) => ReactNode;
  readonly detailFor?: (data: TData) => ReactNode;
  readonly detailRowsFor?: (data: TData) => number;
  readonly compactDetailFor?: (data: TData) => ReactNode;
  readonly onSelect: (
    value: TValue,
    controls: AsyncListFormControls<TData>,
  ) => void;
}

/** Async list lifecycle plus the shared picker layout. */
export function AsyncListForm<TData, TValue>(
  props: AsyncListFormProps<TData, TValue>,
): React.JSX.Element {
  const {
    loadingLabel,
    load,
    items: itemsFor,
    isEmpty,
    showTransientCloseHint,
    descriptionFor,
    detailFor,
    detailRowsFor,
    compactDetailFor,
    onSelect,
    ...listProps
  } = props;
  const picker = useAsyncPickerForm<TData, TValue>({
    title: listProps.title,
    loadingLabel,
    showTransientCloseHint,
    load,
    isEmpty: isEmpty ?? ((loaded) => itemsFor(loaded).length === 0),
    items: itemsFor,
    onSelect,
    onClose: listProps.onCancel,
  });

  if (picker.transient) return picker.transient;
  const { data } = picker;
  if (data === undefined) {
    throw new Error(`${listProps.title} list finished loading without data.`);
  }

  return (
    <ListForm
      {...listProps}
      items={picker.items}
      description={descriptionFor?.(data) ?? listProps.description}
      detail={detailFor?.(data) ?? listProps.detail}
      detailRows={detailRowsFor?.(data) ?? listProps.detailRows}
      compactDetail={compactDetailFor?.(data) ?? listProps.compactDetail}
      onSelect={picker.select}
    />
  );
}
