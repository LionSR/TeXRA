// Native Ink 7 text input.
//
// Built directly on `useInput` + `usePaste` — no `ink-text-input` dependency.
// usePaste auto-enables bracketed paste mode so multi-line pastes arrive as
// a single string and never trigger `onSubmit` on the first embedded `\n`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, useInput, usePaste } from 'ink';

import {
  applyTerminalInputChunk,
  clampCursor,
  insertText,
  maskDisplayValue,
  verticalCursorMove,
  type CursorEdit,
  type TextEdit,
  type TextInputChunkEdit,
} from './textInputEditing';
import { matchTextInputBinding } from './textInputBindings';
import {
  isPlainReturnInput,
  isCtrlInput,
  isEscapeInput,
  isTextInputNewlineInput,
  isUnhandledControlInput,
  metaChordInput,
} from './inputKeys';
import {
  ImagePasteQueue,
  withImagePasteTimeout,
  type ImagePasteAttempt,
} from './imagePasteQueue';
import { useActiveDraft } from './activeDraft';
import { textDisplayWidth } from '../render/terminalText';

const ESC_SLASH_PREFIX = '\u001B/';

export interface BaseTextInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly focus?: boolean;
  /** Clamp the rendered value to this many terminal rows while preserving
   *  the full editable value passed to onChange/onSubmit. */
  readonly maxDisplayRows?: number;
  readonly displayWidth?: number;
  /** Pin the caret externally. When omitted, the component tracks the caret
   *  internally so arrow keys / Home/End / Ctrl-A,E,U,K,W work out of the box. */
  readonly cursor?: number;
  readonly onCursorChange?: (cursor: number) => void;
  readonly onSubmit: (value: string) => void;
  readonly onInputChunkSubmit?: (value: string) => void;
  readonly onChange: (value: string) => void;
  /** ↑ pressed while the caret is on the first line of the draft (where ↑ has
   *  no in-draft meaning) — input bars use this for shell-style history
   *  recall. Within a multiline draft, ↑/↓ move the caret between lines. */
  readonly onHistoryUp?: () => void;
  /** ↓ pressed while the caret is on the last line of the draft. */
  readonly onHistoryDown?: () => void;
  /** Optionally transform pasted text before it is inserted — e.g. collapse a
   *  large paste into a `[Pasted text #N +M lines]` chip and stash the content
   *  elsewhere. Defaults to inserting the paste verbatim. */
  readonly transformPaste?: (text: string) => string;
  /** Ctrl-V handler: probe the OS clipboard for an image. Resolves to the chip
   *  text to insert (e.g. `[Image #1]`) or null when there is no image. */
  readonly onImagePaste?: (
    attempt: ImagePasteAttempt,
  ) => Promise<string | null>;
  readonly onImagePasteError?: (error: unknown) => void;
  readonly imagePasteQueue?: ImagePasteQueue;
  /** Optional parent-owned value ref for same-tick programmatic draft changes. */
  readonly readLatestValue?: () => string;
  /** Optional parent-owned edit applied before a raw terminal chunk is handled. */
  readonly prepareInputChunk?: (
    input: string,
    value: string,
    cursor: number,
  ) => TextEdit | undefined;
  readonly shouldDropInputChunk?: (
    input: string,
    value: string,
    cursor: number,
  ) => boolean;
  /** Apply an edit when Escape is received before normal text handling. */
  readonly escapeEdit?: CursorEdit;
  /** Render the value as bullets (secret entry, e.g. an API key). Display-only:
   *  the captured value, edits, and paste are unaffected. */
  readonly masked?: boolean;
}

export interface TextInputDisplayWindow {
  readonly value: string;
  readonly cursor: number;
  readonly clipped: boolean;
}

interface TextInputDisplayRow {
  readonly start: number;
  readonly end: number;
  readonly breakKind: 'soft' | 'hard' | 'end';
}

interface LeadingEllipsisDisplay {
  readonly text: string;
  readonly removedPrefixCodeUnits: number;
}

function codePointAtIndex(
  value: string,
  index: number,
): { readonly char: string; readonly nextIndex: number } | undefined {
  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) return undefined;
  const char = String.fromCodePoint(codePoint);
  return { char, nextIndex: index + char.length };
}

function isSoftBreakChar(char: string): boolean {
  return char !== '\n' && /\s/u.test(char);
}

function shouldWrapAtPreviousSoftBreak(
  width: number,
  column: number,
  lastSoftBreakColumn: number | undefined,
): boolean {
  if (lastSoftBreakColumn === undefined) return false;
  return column - lastSoftBreakColumn <= Math.max(8, Math.floor(width / 4));
}

function softBreakRunEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const point = codePointAtIndex(value, index);
    if (point === undefined || !isSoftBreakChar(point.char)) break;
    index = point.nextIndex;
  }
  return index;
}

function appendSoftDisplayRow(
  rows: TextInputDisplayRow[],
  value: string,
  start: number,
  end: number,
): void {
  if (value.slice(start, end).trimEnd().length === 0) return;
  rows.push({ start, end, breakKind: 'soft' });
}

function textInputDisplayRows(
  value: string,
  width: number,
): TextInputDisplayRow[] {
  const rows: TextInputDisplayRow[] = [];
  let rowStart = 0;
  let column = 0;
  let lastSoftBreakIndex: number | undefined;
  let lastSoftBreakColumn: number | undefined;

  let index = 0;
  while (index < value.length) {
    const point = codePointAtIndex(value, index);
    if (point === undefined) break;

    if (point.char === '\n') {
      rows.push({ start: rowStart, end: index, breakKind: 'hard' });
      rowStart = point.nextIndex;
      index = point.nextIndex;
      column = 0;
      lastSoftBreakIndex = undefined;
      lastSoftBreakColumn = undefined;
      continue;
    }

    const charWidth = textDisplayWidth(point.char);
    if (column + charWidth > width && column > 0) {
      let wrapIndex = index;
      if (isSoftBreakChar(point.char)) {
        wrapIndex = softBreakRunEnd(value, index);
      } else if (
        lastSoftBreakIndex !== undefined &&
        lastSoftBreakIndex > rowStart &&
        shouldWrapAtPreviousSoftBreak(width, column, lastSoftBreakColumn)
      ) {
        wrapIndex = lastSoftBreakIndex;
      }
      appendSoftDisplayRow(rows, value, rowStart, wrapIndex);
      rowStart = wrapIndex;
      index = wrapIndex;
      column = 0;
      lastSoftBreakIndex = undefined;
      lastSoftBreakColumn = undefined;
      continue;
    }

    column += charWidth;
    if (isSoftBreakChar(point.char)) {
      lastSoftBreakIndex = point.nextIndex;
      lastSoftBreakColumn = column;
    }
    index = point.nextIndex;
  }

  if (rowStart < value.length || rows.at(-1)?.breakKind !== 'soft') {
    rows.push({ start: rowStart, end: value.length, breakKind: 'end' });
  }
  return rows;
}

function textInputDisplayRowValue(
  value: string,
  row: TextInputDisplayRow,
): string {
  const text = value.slice(row.start, row.end);
  return row.breakKind === 'soft' ? text.trimEnd() : text;
}

function cursorDisplayRowIndex(
  rows: readonly TextInputDisplayRow[],
  cursor: number,
): number {
  const rowIndex = rows.findIndex((row, index) => {
    if (cursor < row.start || cursor > row.end) return false;
    if (cursor === row.end && row.breakKind === 'soft') {
      return index === rows.length - 1;
    }
    return true;
  });
  return rowIndex < 0 ? Math.max(0, rows.length - 1) : rowIndex;
}

function leadingEllipsisDisplay(
  text: string,
  width: number,
): LeadingEllipsisDisplay {
  if (width <= 1) {
    return { text: '…', removedPrefixCodeUnits: text.length };
  }
  if (textDisplayWidth(text) < width) {
    return { text: `…${text}`, removedPrefixCodeUnits: 0 };
  }

  let suffix = '';
  const chars = [...text];
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index] ?? '';
    const candidate = `${char}${suffix}`;
    if (textDisplayWidth(candidate) > width - textDisplayWidth('…')) break;
    suffix = candidate;
  }
  return {
    text: `…${suffix}`,
    removedPrefixCodeUnits: text.length - suffix.length,
  };
}

export function textInputDisplayWindow({
  cursor,
  maxDisplayRows,
  value,
  width,
}: {
  readonly cursor: number;
  readonly maxDisplayRows?: number;
  readonly value: string;
  readonly width?: number;
}): TextInputDisplayWindow {
  const rowCount = Math.max(1, maxDisplayRows ?? 0);
  const columnCount = Math.max(1, width ?? 0);
  if (maxDisplayRows === undefined || width === undefined) {
    return { value, cursor: clampCursor(cursor, value.length), clipped: false };
  }

  const sourceCursor = clampCursor(cursor, value.length);
  const rows = textInputDisplayRows(value, columnCount);
  const cursorRowIndex = cursorDisplayRowIndex(rows, sourceCursor);
  const keepRowsAfterCursor =
    rows.length <= rowCount
      ? rows.length - cursorRowIndex - 1
      : Math.min(rows.length - cursorRowIndex - 1, Math.floor(rowCount / 4));
  const endRow =
    rows.length <= rowCount
      ? rows.length
      : Math.min(rows.length, cursorRowIndex + keepRowsAfterCursor + 1);
  const startRow = rows.length <= rowCount ? 0 : Math.max(0, endRow - rowCount);
  const visibleRows = rows.slice(startRow, endRow);
  const clipped = startRow > 0 || endRow < rows.length;
  const rowTexts = visibleRows.map((row) =>
    textInputDisplayRowValue(value, row),
  );
  const displayCursorRow = Math.max(0, cursorRowIndex - startRow);
  const cursorRowTextLength = rowTexts[displayCursorRow]?.length ?? 0;
  let firstRowEllipsisRemovedPrefixCodeUnits = 0;
  if (clipped && startRow > 0) {
    const firstRow = leadingEllipsisDisplay(rowTexts[0] ?? '', columnCount);
    firstRowEllipsisRemovedPrefixCodeUnits = firstRow.removedPrefixCodeUnits;
    rowTexts[0] = firstRow.text;
  }
  const displayValue = rowTexts.join('\n');
  const cursorRow = visibleRows[displayCursorRow] ?? visibleRows.at(-1);
  const cursorColumn =
    cursorRow === undefined
      ? 0
      : clampCursor(sourceCursor - cursorRow.start, cursorRowTextLength);
  let ellipsisCursorColumn: number;
  if (clipped && startRow > 0 && displayCursorRow === 0) {
    ellipsisCursorColumn =
      firstRowEllipsisRemovedPrefixCodeUnits > 0
        ? Math.max(1, cursorColumn - firstRowEllipsisRemovedPrefixCodeUnits + 1)
        : cursorColumn + 1;
  } else {
    ellipsisCursorColumn = cursorColumn;
  }
  const cursorPrefixLength = rowTexts
    .slice(0, displayCursorRow)
    .reduce((sum, row) => sum + row.length + 1, 0);

  return {
    value: displayValue,
    cursor: clampCursor(
      cursorPrefixLength + ellipsisCursorColumn,
      displayValue.length,
    ),
    clipped,
  };
}

export function BaseTextInput(props: BaseTextInputProps): React.JSX.Element {
  const {
    displayWidth,
    value,
    maxDisplayRows,
    placeholder,
    focus = true,
    onChange,
    onInputChunkSubmit,
    onSubmit,
    onCursorChange,
  } = props;

  const isControlled = props.cursor !== undefined;
  const [internalCursor, setInternalCursor] = useState<number>(value.length);
  const cursor = clampCursor(props.cursor ?? internalCursor, value.length);

  // Mirror the latest value/cursor for async handlers (image paste): a
  // clipboard probe that resolves after the user keeps typing must insert at
  // the current caret, not a stale keypress-time snapshot.
  const latestStateRef = useRef({ value, cursor });
  latestStateRef.current = { value, cursor };
  const ownedImagePasteQueueRef = useRef<ImagePasteQueue | null>(null);
  ownedImagePasteQueueRef.current ??= new ImagePasteQueue();
  const imagePasteQueue =
    props.imagePasteQueue ?? ownedImagePasteQueueRef.current;

  // Track the last value we ourselves emitted via onChange. If the prop's
  // `value` diverges from this, the parent swapped the text out from under
  // us (slash-palette accept, reverse-search recall, programmatic clear) —
  // snap the caret to the end so the next keystroke lands at the intuitive
  // spot, not whatever cursor index happened to be valid before.
  const lastEmittedValueRef = useRef<string>(value);
  useEffect(() => {
    if (lastEmittedValueRef.current === value) return;
    lastEmittedValueRef.current = value;
    if (!isControlled) setInternalCursor(value.length);
    onCursorChange?.(value.length);
  }, [value, isControlled, onCursorChange]);

  const moveCursor = useCallback(
    (next: number) => {
      const latest = latestStateRef.current;
      const c = clampCursor(next, latest.value.length);
      latestStateRef.current = { value: latest.value, cursor: c };
      if (!isControlled) setInternalCursor(c);
      onCursorChange?.(c);
    },
    [isControlled, onCursorChange],
  );

  const moveCursorTo = useCallback(
    (target: (value: string, cursor: number) => number) => {
      const { value: v, cursor: c } = latestStateRef.current;
      moveCursor(target(v, c));
    },
    [moveCursor],
  );

  const applyEdit = useCallback(
    (edit: TextEdit) => {
      const c = clampCursor(edit.cursor, edit.value.length);
      latestStateRef.current = { value: edit.value, cursor: c };
      lastEmittedValueRef.current = edit.value;
      onChange(edit.value);
      if (!isControlled) setInternalCursor(c);
      onCursorChange?.(c);
    },
    [isControlled, onChange, onCursorChange],
  );

  const syncLatestExternalValue = useCallback((): TextEdit => {
    const externalValue = props.readLatestValue?.();
    const latest = latestStateRef.current;
    if (externalValue === undefined || externalValue === latest.value) {
      return latest;
    }
    const cursor = clampCursor(latest.cursor, externalValue.length);
    const next = { value: externalValue, cursor };
    latestStateRef.current = next;
    if (!isControlled) setInternalCursor(cursor);
    onCursorChange?.(cursor);
    return next;
  }, [isControlled, onCursorChange, props.readLatestValue]);

  const prepareInputChunkState = useCallback(
    (input: string): TextEdit => {
      const latest = syncLatestExternalValue();
      const prepared = props.prepareInputChunk?.(
        input,
        latest.value,
        latest.cursor,
      );
      if (prepared === undefined) return latest;
      const next = {
        value: prepared.value,
        cursor: clampCursor(prepared.cursor, prepared.value.length),
      };
      latestStateRef.current = next;
      lastEmittedValueRef.current = next.value;
      return next;
    },
    [props.prepareInputChunk, syncLatestExternalValue],
  );

  const insertIntoLatestDraft = useCallback(
    (text: string) => {
      const { value: v, cursor: c } = latestStateRef.current;
      applyEdit(insertText(v, c, text));
    },
    [applyEdit],
  );

  const applyLatestEdit = useCallback(
    (edit: CursorEdit) => {
      const { value: v, cursor: c } = latestStateRef.current;
      applyEdit(edit(v, c));
    },
    [applyEdit],
  );

  const discardDraft = useCallback((): boolean => {
    const latest = syncLatestExternalValue();
    if (
      latest.value.length === 0 &&
      !imagePasteQueue.hasPending &&
      !imagePasteQueue.hasDeferredAction
    ) {
      return false;
    }
    imagePasteQueue.discardPending();
    applyEdit({ value: '', cursor: 0 });
    return true;
  }, [applyEdit, imagePasteQueue, syncLatestExternalValue]);
  useActiveDraft(discardDraft, focus);

  const submitAfterImagePastes = useCallback(
    (handler: (value: string) => void, submitted: string): void => {
      if (
        !imagePasteQueue.deferUntilIdle(() =>
          handler(latestStateRef.current.value),
        )
      ) {
        handler(submitted);
      }
    },
    [imagePasteQueue],
  );

  const commitInputChunkEdit = useCallback(
    (edit: TextInputChunkEdit, previous: TextEdit) => {
      if (edit.submit) {
        submitAfterImagePastes(onInputChunkSubmit ?? onSubmit, edit.value);
        return;
      }
      if (edit.value === previous.value && edit.cursor === previous.cursor) {
        return;
      }
      applyEdit(edit);
    },
    [applyEdit, onInputChunkSubmit, onSubmit, submitAfterImagePastes],
  );

  useInput(
    (input, key) => {
      if (isEscapeInput(input, key)) {
        imagePasteQueue.cancelDeferredAction();
        if (props.escapeEdit) {
          applyLatestEdit(props.escapeEdit);
        }
        return;
      }
      if (imagePasteQueue.hasDeferredAction) {
        // A visible Enter already committed this draft. Ignore later keystrokes
        // until clipboard probes settle so the deferred submit is neither
        // overwritten nor allowed to clear a newer draft.
        return;
      }
      const latestBeforeInput = syncLatestExternalValue();
      if (
        props.shouldDropInputChunk?.(
          input,
          latestBeforeInput.value,
          latestBeforeInput.cursor,
        ) === true
      ) {
        return;
      }

      if (isTextInputNewlineInput(input, key)) {
        // Ctrl-J (universal) or Shift+Enter (Kitty-protocol terminals) →
        // literal newline. Kills the legacy `/multi` ceremony.
        insertIntoLatestDraft('\n');
        return;
      }
      if (isPlainReturnInput(input, key)) {
        submitAfterImagePastes(onSubmit, latestStateRef.current.value);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const { value: v, cursor: c } = latestStateRef.current;
        const moved = verticalCursorMove(v, c, key.upArrow ? -1 : 1);
        if (moved !== undefined) {
          moveCursor(moved);
        } else {
          (key.upArrow ? props.onHistoryUp : props.onHistoryDown)?.();
        }
        return;
      }
      // Stateless editing chords dispatch through the declarative keymap;
      // unmatched meta/ctrl combos fall through to the drop branch below.
      const binding = matchTextInputBinding(input, key);
      if (binding) {
        if ('edit' in binding) applyLatestEdit(binding.edit);
        else moveCursorTo(binding.move);
        return;
      }
      if (isCtrlInput(input, key, 'v') && props.onImagePaste) {
        // Insert the chip at whatever the caret is when the async probe
        // resolves (read from a ref, not a keypress-time snapshot) so typing
        // during the probe isn't clobbered.
        const attempt = imagePasteQueue.beginAttempt();
        const paste = withImagePasteTimeout(
          Promise.resolve().then(() => props.onImagePaste?.(attempt) ?? null),
        )
          .then((chip) => {
            if (!chip || !attempt.isCurrent()) return;
            insertIntoLatestDraft(chip);
          })
          .catch((err: unknown) => {
            if (attempt.isCurrent()) props.onImagePasteError?.(err);
          });
        imagePasteQueue.track(paste);
        return;
      }
      if (input.startsWith(ESC_SLASH_PREFIX) && !key.meta && props.escapeEdit) {
        imagePasteQueue.cancelDeferredAction();
        const latest = syncLatestExternalValue();
        const escaped = props.escapeEdit(latest.value, latest.cursor);
        const escapedState = {
          value: escaped.value,
          cursor: clampCursor(escaped.cursor, escaped.value.length),
        };
        latestStateRef.current = escapedState;
        lastEmittedValueRef.current = escapedState.value;
        commitInputChunkEdit(
          applyTerminalInputChunk(
            escapedState.value,
            escapedState.cursor,
            input.slice(1),
          ),
          escapedState,
        );
        return;
      }
      // Drop unhandled control/meta combos; pass printable input through.
      if (
        key.meta ||
        metaChordInput(input, key) ||
        (key.ctrl && input.length === 1) ||
        isUnhandledControlInput(input) ||
        !input
      ) {
        return;
      }
      const { value: latestValue, cursor: latestCursor } =
        prepareInputChunkState(input);
      commitInputChunkEdit(
        applyTerminalInputChunk(latestValue, latestCursor, input),
        { value: latestValue, cursor: latestCursor },
      );
    },
    { isActive: focus },
  );

  // Bracketed paste arrives as ONE string and is not forwarded to useInput,
  // so newlines in the paste are preserved literally instead of firing Enter.
  // `transformPaste` (when supplied) may collapse a large paste into a chip;
  // otherwise the paste is inserted verbatim.
  usePaste(
    (text) => {
      if (imagePasteQueue.hasDeferredAction) return;
      const toInsert = props.transformPaste?.(text) ?? text;
      insertIntoLatestDraft(toInsert);
    },
    { isActive: focus },
  );

  if (value.length === 0) {
    if (!focus) {
      return placeholder ? <Text dimColor>{placeholder}</Text> : <Text> </Text>;
    }
    return (
      <Text>
        <Text inverse> </Text>
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </Text>
    );
  }

  const display = textInputDisplayWindow({
    cursor,
    maxDisplayRows,
    value,
    width: displayWidth,
  });
  // Mask only at the render layer. maskDisplayValue preserves length, so the
  // caret index from textInputDisplayWindow stays valid against the masked text.
  const shownValue = props.masked
    ? maskDisplayValue(display.value)
    : display.value;

  if (!focus) return <Text>{shownValue}</Text>;

  const before = shownValue.slice(0, display.cursor);
  const ch = shownValue[display.cursor];
  const after = shownValue.slice(display.cursor + 1);
  // Inverse-on-newline collapses to nothing visible; render the caret as a
  // leading space and let the literal newline carry the line break.
  if (ch === '\n') {
    return (
      <Text>
        {before}
        <Text inverse> </Text>
        {'\n'}
        {after}
      </Text>
    );
  }
  return (
    <Text>
      {before}
      <Text inverse>{ch ?? ' '}</Text>
      {after}
    </Text>
  );
}
