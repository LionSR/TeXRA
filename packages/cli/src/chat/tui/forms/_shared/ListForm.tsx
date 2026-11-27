import { Box, Text, useBoxMetrics, useWindowSize, type DOMElement } from 'ink';
import { useRef, type ReactNode } from 'react';

import { wrappedRowCount } from '@cli/tui/ansiWrap';
import { COLOR_WARNING } from '@cli/tui/ui/colors';
import {
  CLOSE_HINT,
  CLOSE_HINTS,
  ENTER_OR_ESC_CLOSE_HINTS,
  KeyHints,
  type KeyHint,
  NAVIGATE_HINT,
} from '@cli/tui/ui/KeyHints';
import {
  Select,
  selectHotkeyRangeLabel,
  type SelectItem,
} from '@cli/tui/ui/Select';

import {
  FormFrame,
  formFrameChromeRows,
  formFrameContentWidth,
  renderAsyncListFormTransient,
} from './FormFrame';
import { useAsyncListForm } from './useAsyncListForm';
import type { ProcessServices } from '@texra-ai/worldline/host';
import type { Effect } from 'effect';

/** At or below this many rows a form drops to its one-row compact layout. */
const COMPACT_FORM_MAX_ROWS = 9;

/**
 * How many list rows the form's `Select` may show and whether to spend rows
 * on overflow markers. The frame (`frameRows`), the wrapped description
 * (`descriptionRows`) and the measured detail rows come off the budget first; on a very
 * short terminal (fewer than 3 list rows) the active choice stays visible
 * instead of the whole budget going to overflow markers.
 */
function listFormSelectWindow(args: {
  readonly availableRows: number;
  readonly itemCount: number;
  readonly frameRows: number;
  readonly descriptionRows: number;
  readonly detailRows: number;
  readonly selectMarginTop?: number;
}): {
  readonly maxVisibleItems: number;
  readonly showOverflow: boolean;
} {
  const chromeRows =
    args.frameRows +
    args.descriptionRows +
    args.detailRows +
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
  readonly availableRows: number;
  readonly items: ReadonlyArray<SelectItem<T>>;
  readonly activeValue?: T;
  /** One dim line of guidance under the title. The form paints it and
   *  counts the rows it wraps to, so a long line never pushes the list out
   *  of the frame. */
  readonly description?: string;
  /** Anything else between the description and the list. The form
   *  measures the rows it takes, wrapped lines and margins included. */
  readonly detail?: ReactNode;
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
  const { columns } = useWindowSize();
  const detailRef = useRef<DOMElement>(null);
  // Zero until the first layout, and in the layouts that draw no detail box.
  const detailRows = useBoxMetrics(detailRef).height;
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

  const hotkeys = selectHotkeyRangeLabel(props.items.length);
  const primary = {
    key: hotkeys === undefined ? 'Enter' : `${hotkeys}/Enter`,
    action: props.action,
  };
  const escape = props.escape ?? CLOSE_HINT;

  if (props.availableRows <= COMPACT_FORM_MAX_ROWS) {
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
        <KeyHints hints={[NAVIGATE_HINT, primary, escape]} />
      </FormFrame>
    );
  }

  const hints = [NAVIGATE_HINT, primary, ...(props.extraHints ?? []), escape];
  const contentWidth = formFrameContentWidth(columns);
  const selectWindow = listFormSelectWindow({
    availableRows: props.availableRows,
    itemCount: props.items.length,
    frameRows: formFrameChromeRows(props.title, hints, contentWidth),
    descriptionRows: props.description
      ? wrappedRowCount(props.description, contentWidth)
      : 0,
    detailRows,
    selectMarginTop: props.selectMarginTop,
  });
  return (
    <FormFrame title={props.title} hints={hints}>
      {props.description ? <Text dimColor>{props.description}</Text> : null}
      <Box ref={detailRef} flexDirection="column" flexShrink={0}>
        {props.detail}
      </Box>
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

interface AsyncListFormControls<TData> {
  readonly data: TData;
  /** Run a write, then reload the list, keeping the current data on screen
   *  until it returns; a failed write becomes a transient notice. */
  readonly update: (write: Effect.Effect<void, Error, ProcessServices>) => void;
}

interface AsyncListFormProps<TData, TValue> extends Omit<
  ListFormProps<TValue>,
  'items' | 'onSelect' | 'detail' | 'compactDetail'
> {
  readonly loadingLabel: string;
  readonly load: () => Effect.Effect<TData, Error, ProcessServices>;
  readonly items: (data: TData) => ReadonlyArray<SelectItem<TValue>>;
  readonly isEmpty?: (data: TData) => boolean;
  /** `false` renders a read-only list where selecting closes the form. */
  readonly selectable?: boolean;
  readonly detailFor?: (data: TData) => ReactNode;
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
    detailFor,
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
      detail={detailFor?.(data)}
      compactDetail={compactDetailFor?.(data)}
      onSelect={select}
    />
  );
}
