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

export function clampCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length));
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

export function deleteToStart(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  return {
    value: value.slice(c),
    cursor: 0,
  };
}

export function deleteToEnd(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  return {
    value: value.slice(0, c),
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

export function applyTerminalInputChunk(
  value: string,
  cursor: number,
  input: string,
): TextInputChunkEdit {
  let edit: TextEdit = { value, cursor: clampCursor(cursor, value.length) };
  let submit = false;

  for (const ch of input) {
    if (ch === SYNTHETIC_SHIFT_RETURN_INPUT) {
      edit = insertText(edit.value, edit.cursor, '\n');
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      submit = true;
      break;
    }

    const ctrl = normalizedCtrlInput(ch, {});
    if (ctrl === 'a') {
      edit = { value: edit.value, cursor: 0 };
      continue;
    }
    if (ctrl === 'e') {
      edit = { value: edit.value, cursor: edit.value.length };
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
