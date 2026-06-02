export const ANSI_ESCAPE_START = String.fromCharCode(27);

const ANSI_BEL = String.fromCharCode(7);

export function ansiEscapeEnd(text: string, index: number): number {
  if (text[index] !== ANSI_ESCAPE_START) return index;

  const next = text[index + 1];
  if (next === '[') {
    for (let end = index + 2; end < text.length; end += 1) {
      const code = text.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) return end + 1;
    }
    return text.length;
  }

  if (next === ']') {
    const belEnd = text.indexOf(ANSI_BEL, index + 2);
    const stEnd = text.indexOf(`${ANSI_ESCAPE_START}\\`, index + 2);
    if (belEnd === -1 && stEnd === -1) return text.length;
    if (belEnd !== -1 && (stEnd === -1 || belEnd < stEnd)) return belEnd + 1;
    return stEnd + 2;
  }

  return Math.min(index + 2, text.length);
}

export function stripAnsiSequences(text: string): string {
  let stripped = '';
  for (let index = 0; index < text.length; ) {
    if (text[index] === ANSI_ESCAPE_START) {
      index = ansiEscapeEnd(text, index);
      continue;
    }
    stripped += text[index];
    index += 1;
  }
  return stripped;
}
