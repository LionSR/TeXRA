export const ANSI_ESCAPE_START = String.fromCharCode(27);

const ANSI_BEL = String.fromCharCode(7);
const ANSI_C1_STRING_TERMINATOR = String.fromCharCode(0x9c);

/** A CSI sequence (`ESC [`) ends at its final byte, in the range `@`–`~`. */
const CSI_FINAL_BYTE_MIN = 0x40; // '@'
const CSI_FINAL_BYTE_MAX = 0x7e; // '~'

/** An OSC sequence (`ESC ]`) ends with BEL or the two-char ST (`ESC \`). */
const OSC_STRING_TERMINATOR = `${ANSI_ESCAPE_START}\\`;

/** ISO-2022 intermediate bytes for charset/line-size designators (`ESC ( 0`, `ESC # 3`, etc.). */
function isAnsiIntermediateByte(char: string | undefined): boolean {
  return char === '(' || char === ')' || char === '#';
}

export function ansiEscapeEnd(text: string, index: number): number {
  if (text[index] !== ANSI_ESCAPE_START) return index;

  const next = text[index + 1];
  if (next === '[') {
    for (let end = index + 2; end < text.length; end += 1) {
      const code = text.charCodeAt(end);
      if (code >= CSI_FINAL_BYTE_MIN && code <= CSI_FINAL_BYTE_MAX) {
        return end + 1;
      }
    }
    return text.length;
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
