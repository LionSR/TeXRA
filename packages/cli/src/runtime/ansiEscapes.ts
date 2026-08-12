export const ANSI_ESCAPE_START = String.fromCharCode(27);
export const ANSI_C1_CSI_START = String.fromCharCode(0x9b);

const ANSI_BEL = String.fromCharCode(7);
const ANSI_C1_STRING_TERMINATOR = String.fromCharCode(0x9c);

/** A CSI sequence (`ESC [`) ends at its final byte, in the range `@`–`~`. */
const CSI_FINAL_BYTE_MIN = 0x40; // '@'
const CSI_FINAL_BYTE_MAX = 0x7e; // '~'

/**
 * Whether a code point is a CSI final byte. Single owner of the ANSI final-byte
 * range; `noColorOutput` scans CSI sequences with this rather than re-deriving
 * the range.
 */
export function isCsiFinalByte(code: number): boolean {
  return code >= CSI_FINAL_BYTE_MIN && code <= CSI_FINAL_BYTE_MAX;
}

/** An OSC sequence (`ESC ]`) ends with BEL or the two-char ST (`ESC \`). */
const OSC_STRING_TERMINATOR = `${ANSI_ESCAPE_START}\\`;

/** ISO-2022 intermediate bytes for charset/line-size designators (`ESC ( 0`, `ESC # 3`, etc.). */
function isAnsiIntermediateByte(char: string | undefined): boolean {
  return char === '(' || char === ')' || char === '#';
}

function csiEscapeEnd(text: string, start: number): number {
  for (let end = start; end < text.length; end += 1) {
    if (isCsiFinalByte(text.charCodeAt(end))) {
      return end + 1;
    }
  }
  return text.length;
}

export function ansiEscapeEnd(text: string, index: number): number {
  if (text[index] === ANSI_C1_CSI_START) return csiEscapeEnd(text, index + 1);
  if (text[index] !== ANSI_ESCAPE_START) return index;

  const next = text[index + 1];
  if (next === '[') {
    return csiEscapeEnd(text, index + 2);
  }

  if (next === ']') {
    const belEnd = text.indexOf(ANSI_BEL, index + 2);
    const stEnd = text.indexOf(OSC_STRING_TERMINATOR, index + 2);
    const c1End = text.indexOf(ANSI_C1_STRING_TERMINATOR, index + 2);
    const ends = [
      belEnd === -1 ? undefined : belEnd + 1,
      stEnd === -1 ? undefined : stEnd + OSC_STRING_TERMINATOR.length,
      c1End === -1 ? undefined : c1End + 1,
    ].filter((end): end is number => end !== undefined);
    return ends.length === 0 ? text.length : Math.min(...ends);
  }

  if (isAnsiIntermediateByte(next)) {
    let end = index + 1;
    while (end < text.length && isAnsiIntermediateByte(text[end])) end += 1;
    return Math.min(end + 1, text.length);
  }

  return Math.min(index + 2, text.length);
}
