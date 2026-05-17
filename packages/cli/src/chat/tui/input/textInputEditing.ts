export interface TextEdit {
  readonly value: string;
  readonly cursor: number;
}

export function clampCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length));
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
