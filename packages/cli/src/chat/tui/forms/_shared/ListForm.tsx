import { Box, Text } from 'ink';
import { useEffect, useRef, type ReactNode } from 'react';

import { COLOR_WARNING } from '@cli/chat/tui/ui/colors';
import { KeyHints } from '@cli/chat/tui/ui/KeyHints';
import {
  Select,
  selectIndexForHotkeyInput,
  type SelectItem,
} from '@cli/chat/tui/ui/Select';

import {
  CompactFormKeyHints,
  FormFrame,
  renderAsyncListFormTransient,
} from './FormFrame';
import {
  computeSelectWindowSize,
  isCompactFormRows,
  type SelectWindowSize,
} from './selectWindow';
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

  if (isCompactFormRows(props.availableRows)) {
    const shortcut = listFormShortcutLabel(props.items.length);
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
  const shortcut = listFormShortcutLabel(props.items.length);
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

export function usePendingListFormSelection<T>(args: {
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
  const { data, loading, error, pendingInput, clearPendingInput, setData } =
    useAsyncListForm<TData>({
      load: props.load,
      onClose: props.onCancel,
      isEmpty: props.isEmpty ?? ((loaded) => props.items(loaded).length === 0),
    });
  const items = data === undefined ? [] : props.items(data);
  const handleSelect = (value: TValue): void => {
    if (data !== undefined) props.onSelect(value, { data, setData });
  };
  usePendingListFormSelection({
    loading,
    error,
    pendingInput,
    clearPendingInput,
    items,
    onSelect: handleSelect,
  });

  const transient = renderAsyncListFormTransient({
    loading,
    error,
    title: props.title,
    loadingLabel: props.loadingLabel,
    showCloseHint: props.showTransientCloseHint,
  });
  if (transient) return transient;
  if (data === undefined) {
    throw new Error(`${props.title} list finished loading without data.`);
  }

  return (
    <ListForm
      {...props}
      items={items}
      description={props.descriptionFor?.(data) ?? props.description}
      detail={props.detailFor?.(data) ?? props.detail}
      detailRows={props.detailRowsFor?.(data) ?? props.detailRows}
      compactDetail={props.compactDetailFor?.(data) ?? props.compactDetail}
      onSelect={handleSelect}
    />
  );
}
