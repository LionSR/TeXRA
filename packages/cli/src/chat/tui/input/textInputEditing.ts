import { clamp } from '@utils/core';

import {
  isEscapeInput,
  isUnhandledControlInput,
  normalizedCtrlInput,
  SYNTHETIC_SHIFT_RETURN_INPUT,
} from './inputKeys';

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

export function deleteBeforeCursor(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  if (c === 0) return { value, cursor: c };
  return {
    value: value.slice(0, c - 1) + value.slice(c),
    cursor: c - 1,
  };
}

export function deleteAtCursor(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  if (c >= value.length) return { value, cursor: c };
  return {
    value: value.slice(0, c) + value.slice(c + 1),
    cursor: c,
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

/** Ctrl-U: delete from the start of the current line to the cursor. */
export function deleteToStart(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  const start = lineStartCursor(value, c);
  return {
    value: value.slice(0, start) + value.slice(c),
    cursor: start,
  };
}

/** Ctrl-K: delete from the cursor to the end of the current line; at the
 *  end of a line it kills the newline, joining the next line (readline). */
export function deleteToEnd(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  const lineEnd = lineEndCursor(value, c);
  const end = lineEnd === c && c < value.length ? c + 1 : lineEnd;
  return {
    value: value.slice(0, c) + value.slice(end),
    cursor: c,
  };
}

export function deletePreviousWord(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  const left = value.slice(0, c);
  const trimmed = left.replace(/\S*\s*$/, '');
  return {
    value: trimmed + value.slice(c),
    cursor: trimmed.length,
  };
}

/** Alt-D / readline `kill-word`: delete from the cursor through the end of
 *  the next word (skipping any whitespace in between). */
export function deleteNextWord(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  const right = value.slice(c);
  const removed = /^\s*\S*/.exec(right)?.[0].length ?? 0;
  return {
    value: value.slice(0, c) + value.slice(c + removed),
    cursor: c,
  };
}

/** Alt-B / Ctrl-← target: start of the word at (or before) the cursor. */
export function previousWordCursor(value: string, cursor: number): number {
  const c = clampCursor(cursor, value.length);
  return value.slice(0, c).replace(/\S*\s*$/, '').length;
}

/** Alt-F / Ctrl-→ target: end of the word at (or after) the cursor. */
export function nextWordCursor(value: string, cursor: number): number {
  const c = clampCursor(cursor, value.length);
  const advanced = /^\s*\S*/.exec(value.slice(c))?.[0].length ?? 0;
  return c + advanced;
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

  let lineStart = 0;
  let lineIndex = 0;
  for (; lineIndex < lines.length; lineIndex += 1) {
    const lineEnd = lineStart + (lines[lineIndex]?.length ?? 0);
    if (c <= lineEnd) break;
    lineStart = lineEnd + 1;
  }

  const targetIndex = lineIndex + direction;
  if (targetIndex < 0 || targetIndex >= lines.length) return undefined;

  let targetStart = 0;
  for (let i = 0; i < targetIndex; i += 1) {
    targetStart += (lines[i]?.length ?? 0) + 1;
  }
  const column = c - lineStart;
  return targetStart + Math.min(column, lines[targetIndex]?.length ?? 0);
}

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
    if (ctrl === 'a') {
      edit = {
        value: edit.value,
        cursor: lineStartCursor(edit.value, edit.cursor),
      };
      continue;
    }
    if (ctrl === 'e') {
      edit = {
        value: edit.value,
        cursor: lineEndCursor(edit.value, edit.cursor),
      };
      continue;
    }
    if (ctrl === 'u') {
      edit = deleteToStart(edit.value, edit.cursor);
      continue;
    }
    if (ctrl === 'k') {
      edit = deleteToEnd(edit.value, edit.cursor);
      continue;
    }
    if (ctrl === 'w') {
      edit = deletePreviousWord(edit.value, edit.cursor);
      continue;
    }
    if (ctrl || isEscapeInput(ch, {}) || isUnhandledControlInput(ch)) {
      continue;
    }

    edit = insertText(edit.value, edit.cursor, ch);
  }

  return { ...edit, submit };
}
