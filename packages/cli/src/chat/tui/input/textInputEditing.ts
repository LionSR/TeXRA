import {
  isEscapeInput,
  isUnhandledControlInput,
  normalizedCtrlInput,
  SYNTHETIC_SHIFT_RETURN_INPUT,
} from '@cli/tui/inputKeys';
import { clamp } from '@utils/core';


export interface TextEdit {
  readonly value: string;
  readonly cursor: number;
}

export interface TextInputChunkEdit extends TextEdit {
  readonly submit: boolean;
}

/**
 * Shape shared by every cursor-positioned editing primitive
 * (`deleteBeforeCursor`, `deleteToEnd`, ...): given the current value and
 * caret, produce the next `TextEdit`.
 */
export type CursorEdit = (value: string, cursor: number) => TextEdit;

export function clampCursor(cursor: number, length: number): number {
  return clamp(cursor, 0, length);
}

/**
 * Replace every visible glyph with a bullet for masked (secret) display,
 * preserving newlines and code-unit length so the caret index stays aligned
 * with the unmasked value. DISPLAY-ONLY: the stored value, edits, and paste
 * never see the mask, so masking can never corrupt the captured key.
 */
export function maskDisplayValue(value: string): string {
  return value.replaceAll(/[^\n]/g, '•');
}

export function insertText(
  value: string,
  cursor: number,
  text: string,
): TextEdit {
  const c = clampCursor(cursor, value.length);
  return {
    value: value.slice(0, c) + text + value.slice(c),
    cursor: c + text.length,
  };
}

/** Home / Ctrl-A target: start of the current logical line (readline
 *  behavior in a multiline draft; index 0 for single-line values). */
export function lineStartCursor(value: string, cursor: number): number {
  const c = clampCursor(cursor, value.length);
  return value.lastIndexOf('\n', c - 1) + 1;
}

/** End / Ctrl-E target: end of the current logical line. */
export function lineEndCursor(value: string, cursor: number): number {
  const c = clampCursor(cursor, value.length);
  const nextBreak = value.indexOf('\n', c);
  return nextBreak === -1 ? value.length : nextBreak;
}

/** Alt-B / Ctrl-← target: start of the word at (or before) the cursor. */
export function previousWordCursor(value: string, cursor: number): number {
  const c = clampCursor(cursor, value.length);
  return value.slice(0, c).replace(/\S*\s*$/, '').length;
}

/** Alt-F / Ctrl-→ target: end of the word at (or after) the cursor. */
export function nextWordCursor(value: string, cursor: number): number {
  const c = clampCursor(cursor, value.length);
  return c + (/^\s*\S*/.exec(value.slice(c))?.[0].length ?? 0);
}

/** Delete the span [from, to) and park the caret at its start. */
function deleteSpan(value: string, from: number, to: number): TextEdit {
  return { value: value.slice(0, from) + value.slice(to), cursor: from };
}

export function deleteBeforeCursor(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  return deleteSpan(value, Math.max(0, c - 1), c);
}

export function deleteAtCursor(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  return deleteSpan(value, c, Math.min(value.length, c + 1));
}

/** Ctrl-U: delete from the start of the current line to the cursor. */
export function deleteToStart(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  return deleteSpan(value, lineStartCursor(value, c), c);
}

/** Ctrl-K: delete from the cursor to the end of the current line; at the
 *  end of a line it kills the newline, joining the next line (readline). */
export function deleteToEnd(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  const lineEnd = lineEndCursor(value, c);
  return deleteSpan(
    value,
    c,
    lineEnd === c && c < value.length ? c + 1 : lineEnd,
  );
}

/** Ctrl-W / Alt-Backspace: delete back to the start of the previous word. */
export function deletePreviousWord(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  return deleteSpan(value, previousWordCursor(value, c), c);
}

/** Alt-D / readline `kill-word`: delete from the cursor through the end of
 *  the next word (skipping any whitespace in between). */
export function deleteNextWord(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  return deleteSpan(value, c, nextWordCursor(value, c));
}

/**
 * ↑/↓ within a multiline draft: cursor position one logical line up or down,
 * preserving the column where the target line is long enough. Returns
 * `undefined` when the cursor is already on the boundary line — the caller
 * decides what the key means then (e.g. ↑ on the first line recalls history).
 */
export function verticalCursorMove(
  value: string,
  cursor: number,
  direction: -1 | 1,
): number | undefined {
  const c = clampCursor(cursor, value.length);
  const lines = value.split('\n');
  let offset = 0;
  const starts = lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });

  const lineIndex = starts.findLastIndex((start) => start <= c);
  const target = lineIndex + direction;
  if (target < 0 || target >= lines.length) return undefined;

  const column = c - (starts[lineIndex] ?? 0);
  return (starts[target] ?? 0) + Math.min(column, lines[target]?.length ?? 0);
}

/** Readline edits honored inside batched terminal input chunks. */
const CHUNK_CTRL_EDITS: Readonly<Record<string, CursorEdit>> = {
  a: (v, c) => ({ value: v, cursor: lineStartCursor(v, c) }),
  e: (v, c) => ({ value: v, cursor: lineEndCursor(v, c) }),
  u: deleteToStart,
  k: deleteToEnd,
  w: deletePreviousWord,
};

export function applyTerminalInputChunk(
  value: string,
  cursor: number,
  input: string,
): TextInputChunkEdit {
  let edit: TextEdit = { value, cursor: clampCursor(cursor, value.length) };
  let submit = false;

  const chars = [...input];
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    if (ch === SYNTHETIC_SHIFT_RETURN_INPUT || ch === '\n') {
      edit = insertText(edit.value, edit.cursor, '\n');
      continue;
    }
    if (ch === '\r') {
      if (chars[index + 1] === '\n' && index + 2 < chars.length) {
        edit = insertText(edit.value, edit.cursor, '\n');
        index += 1;
        continue;
      }
      submit = true;
      break;
    }

    const ctrl = normalizedCtrlInput(ch, {});
    const ctrlEdit = ctrl ? CHUNK_CTRL_EDITS[ctrl] : undefined;
    if (ctrlEdit) {
      edit = ctrlEdit(edit.value, edit.cursor);
      continue;
    }
    if (ctrl || isEscapeInput(ch, {}) || isUnhandledControlInput(ch)) {
      continue;
    }

    edit = insertText(edit.value, edit.cursor, ch);
  }

  return { ...edit, submit };
}
