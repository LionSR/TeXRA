import { Number as Num } from 'effect';
export interface TextEdit {
  readonly value: string;
  readonly cursor: number;
}

/**
 * Shape shared by every cursor-positioned editing primitive
 * (`deleteBeforeCursor`, `deleteToEnd`, ...): given the current value and
 * caret, produce the next `TextEdit`.
 */
export type CursorEdit = (value: string, cursor: number) => TextEdit;

export function clampCursor(cursor: number, length: number): number {
  return Num.clamp(cursor, { minimum: 0, maximum: length });
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface Grapheme {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Looks up the grapheme cluster holding a code unit of `value`: the unit a
 * caret steps over and a delete removes, so an emoji sequence or a letter
 * with combining marks is never cut inside. The lookup answers `undefined`
 * at or past the end. A pass over a whole value takes one lookup and reuses
 * it: segmenting again for every character is quadratic.
 */
export function graphemesOf(
  value: string,
): (index: number) => Grapheme | undefined {
  const segments = GRAPHEMES.segment(value);
  return (index) => {
    const found = segments.containing(index);
    if (found === undefined) return undefined;
    return {
      text: found.segment,
      start: found.index,
      end: found.index + found.segment.length,
    };
  };
}

/** The grapheme cluster holding code unit `index` of `value`. */
export function graphemeAt(value: string, index: number): Grapheme | undefined {
  return graphemesOf(value)(index);
}

/** ← target: the start of the grapheme before the cursor. */
export function previousGraphemeCursor(value: string, cursor: number): number {
  const c = clampCursor(cursor, value.length);
  return graphemeAt(value, c - 1)?.start ?? 0;
}

/** → target: the end of the grapheme at the cursor. */
export function nextGraphemeCursor(value: string, cursor: number): number {
  const c = clampCursor(cursor, value.length);
  return graphemeAt(value, c)?.end ?? value.length;
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

/**
 * Insert `text` at the cursor and leave the caret after it. Text that joins
 * what follows into one grapheme (a regional indicator before another, a
 * joiner between emoji) carries the caret to that grapheme's end, so the
 * stored cursor is never inside a grapheme.
 */
export function insertText(
  value: string,
  cursor: number,
  text: string,
): TextEdit {
  const c = clampCursor(cursor, value.length);
  const next = value.slice(0, c) + text + value.slice(c);
  const after = c + text.length;
  const joined = graphemeAt(next, after);
  return {
    value: next,
    cursor: joined !== undefined && joined.start < after ? joined.end : after,
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

/**
 * Delete the span [from, to) and leave the caret at its start, or at the
 * start of the grapheme the two sides now join into.
 */
function deleteSpan(value: string, from: number, to: number): TextEdit {
  const next = value.slice(0, from) + value.slice(to);
  return { value: next, cursor: graphemeAt(next, from)?.start ?? from };
}

export function deleteBeforeCursor(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  return deleteSpan(value, previousGraphemeCursor(value, c), c);
}

export function deleteAtCursor(value: string, cursor: number): TextEdit {
  const c = clampCursor(cursor, value.length);
  return deleteSpan(value, c, nextGraphemeCursor(value, c));
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
  const moved =
    (starts[target] ?? 0) + Math.min(column, lines[target]?.length ?? 0);
  // The same column on the other line can fall inside a grapheme.
  return graphemeAt(value, moved)?.start ?? moved;
}
