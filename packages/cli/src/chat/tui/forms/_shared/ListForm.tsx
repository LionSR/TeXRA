import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import {
  CLOSE_HINT,
  CLOSE_HINTS,
  ENTER_OR_ESC_CLOSE_HINTS,
  KeyHints,
  type KeyHint,
  NAVIGATE_HINT,
} from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { isCompactRows } from '@cli/tui/ui/theme';

import { FormFrame, renderAsyncListFormTransient } from './FormFrame';
import { useAsyncListForm } from './useAsyncListForm';
import type { ProcessServices } from '@texra-ai/harness/host';
import type { Effect } from 'effect';

const LIST_FORM_FRAME_ROWS = 3;
const LIST_FORM_FOOTER_ROWS = 2;
/** At or below this many rows a form drops to its one-row compact layout. */
const COMPACT_FORM_MAX_ROWS = 9;

/**
 * How many list rows the form's `Select` may show and whether to spend rows
 * on overflow markers. With no row budget it shows everything. Otherwise the
 * frame, footer, description and detail rows come off the budget first; on a
 * very short terminal (fewer than 3 list rows) the active choice stays
 * visible instead of the whole budget going to overflow markers.
 */
function listFormSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
  readonly hasDescription?: boolean;
  readonly detailRows?: number;
  readonly selectMarginTop?: number;
}): {
  readonly maxVisibleItems: number | undefined;
  readonly showOverflow: boolean;
} {
  if (args.availableRows == null) {
    return { maxVisibleItems: undefined, showOverflow: false };
  }
  const chromeRows =
    LIST_FORM_FRAME_ROWS +
    LIST_FORM_FOOTER_ROWS +
    (args.hasDescription ? 1 : 0) +
    Math.max(0, args.detailRows ?? 0) +
    Math.max(0, args.selectMarginTop ?? 0);
  const selectRows = Math.max(1, args.availableRows - chromeRows);
  if (args.itemCount <= selectRows) {
    return { maxVisibleItems: args.itemCount, showOverflow: false };
  }
  if (selectRows < 3) {
    return { maxVisibleItems: selectRows, showOverflow: false };
  }
  return { maxVisibleItems: selectRows - 2, showOverflow: true };
}

interface ListFormProps<T> {
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
  /** The empty picker also closes on Enter; its footer says so. */
  readonly emptyClosesOnEnter?: boolean;
  readonly selectMarginTop?: number;
  readonly action: string;
  /** Form-specific keys shown between the select and `Esc` hints. */
  readonly extraHints?: readonly KeyHint[];
  /** What Esc does, `Esc close` by default. */
  readonly escape?: KeyHint;
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
        hints={
          props.emptyClosesOnEnter ? ENTER_OR_ESC_CLOSE_HINTS : CLOSE_HINTS
        }
      >
        <Text>{props.emptyMessage}</Text>
        {props.detail}
      </FormFrame>
    );
  }

  const primary = {
    key: listFormShortcutLabel(props.items.length),
    action: props.action,
  };
  const escape = props.escape ?? CLOSE_HINT;

  if (isCompactRows(props.availableRows, COMPACT_FORM_MAX_ROWS)) {
    return (
      <FormFrame title={props.compactTitle ?? props.title} hints={[]}>
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
        <KeyHints
          hints={[NAVIGATE_HINT, primary, escape]}
          confirmCancel={false}
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
    <FormFrame
      title={props.title}
      hints={[NAVIGATE_HINT, primary, ...(props.extraHints ?? []), escape]}
    >
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
    </FormFrame>
  );
}

function listFormShortcutLabel(itemCount: number): string {
  if (itemCount <= 0) return 'Enter';
  if (itemCount === 1) return '1/Enter';
  if (itemCount <= 9) return `1-${itemCount}/Enter`;
  return '1-9/a-z/Enter';
}

interface AsyncListFormControls<TData> {
  readonly data: TData;
  /** Run a write, then reload the list, keeping the current data on screen
   *  until it returns; a failed write becomes a transient notice. */
  readonly update: (write: Effect.Effect<void, Error, ProcessServices>) => void;
}

interface AsyncListFormProps<TData, TValue> extends Omit<
  ListFormProps<TValue>,
  'items' | 'onSelect'
> {
  readonly loadingLabel: string;
  readonly load: () => Effect.Effect<TData, Error, ProcessServices>;
  readonly items: (data: TData) => ReadonlyArray<SelectItem<TValue>>;
  readonly isEmpty?: (data: TData) => boolean;
  /** `false` renders a read-only list where selecting closes the form. */
  readonly selectable?: boolean;
  /** The active row's value, one of `items` (Select matches by identity). */
  readonly activeValueFor?: (data: TData) => TValue | undefined;
  readonly detailFor?: (data: TData) => ReactNode;
  readonly detailRowsFor?: (data: TData) => number;
  readonly compactDetailFor?: (data: TData) => ReactNode;
  readonly onSelect: (
    value: TValue,
    controls: AsyncListFormControls<TData>,
  ) => void;
}

/**
 * The async lifecycle every `/`-form picker runs, over the shared picker
 * layout: load once, hold keystrokes typed before the list listens, render
 * the loading/error frame, and turn a selection into the caller's handler (or
 * a close, for a read-only list).
 */
export function AsyncListForm<TData, TValue>(
  props: AsyncListFormProps<TData, TValue>,
): React.JSX.Element {
  const {
    loadingLabel,
    load,
    items: itemsFor,
    isEmpty,
    selectable = true,
    activeValueFor,
    detailFor,
    detailRowsFor,
    compactDetailFor,
    onSelect,
    ...listProps
  } = props;
  const { data, loading, error, update } = useAsyncListForm<TData>({
    load,
    onClose: listProps.onCancel,
    isEmpty: isEmpty ?? ((loaded) => itemsFor(loaded).length === 0),
    closeEmptyOnEnter: listProps.emptyClosesOnEnter,
  });
  const items = data === undefined ? [] : itemsFor(data);
  const select = (value: TValue): void => {
    if (!selectable) {
      listProps.onCancel();
      return;
    }
    if (data !== undefined) onSelect(value, { data, update });
  };
  const transient = renderAsyncListFormTransient({
    loading,
    error,
    title: listProps.title,
    loadingLabel,
  });
  if (transient) return transient;
  if (data === undefined) {
    throw new Error(`${listProps.title} list finished loading without data.`);
  }

  return (
    <ListForm
      {...listProps}
      items={items}
      activeValue={activeValueFor?.(data) ?? listProps.activeValue}
      detail={detailFor?.(data) ?? listProps.detail}
      detailRows={detailRowsFor?.(data) ?? listProps.detailRows}
      compactDetail={compactDetailFor?.(data) ?? listProps.compactDetail}
      onSelect={select}
    />
  );
}
