import wrapAnsi from 'wrap-ansi';

const MIN_WRAP_WIDTH = 1;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

export interface WrapAnsiOptions {
  readonly preserveMarkdownPrefix?: boolean;
}

function normalizedWidth(width: number | undefined): number | undefined {
  if (width == null || !Number.isFinite(width)) return undefined;
  return Math.max(MIN_WRAP_WIDTH, Math.floor(width));
}

function ansiEscapeEnd(text: string, index: number): number {
  if (text[index] !== ESC) return index;
  const next = text[index + 1];
  if (next === '[') {
    let end = index + 2;
    while (end < text.length && !/[@-~]/.test(text[end] ?? '')) end += 1;
    return Math.min(end + 1, text.length);
  }
  if (next === ']') {
    const belEnd = text.indexOf(BEL, index + 2);
    const stEnd = text.indexOf(`${ESC}\\`, index + 2);
    if (belEnd === -1 && stEnd === -1) return text.length;
    if (belEnd !== -1 && (stEnd === -1 || belEnd < stEnd)) return belEnd + 1;
    return stEnd + 2;
  }
  return Math.min(index + 2, text.length);
}

function stripAnsiForPrefix(text: string): string {
  let plain = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === ESC) {
      i = ansiEscapeEnd(text, i);
    } else {
      plain += text[i];
      i += 1;
    }
  }
  return plain;
}

function splitRawAtVisiblePrefix(
  line: string,
  visiblePrefixLength: number,
): { prefix: string; rest: string } {
  let visible = 0;
  let index = 0;
  while (index < line.length && visible < visiblePrefixLength) {
    if (line[index] === ESC) {
      index = ansiEscapeEnd(line, index);
    } else {
      visible += 1;
      index += 1;
    }
  }
  while (line[index] === ESC) index = ansiEscapeEnd(line, index);
  return {
    prefix: line.slice(0, index),
    rest: line.slice(index),
  };
}

function markdownContinuationPrefix(line: string):
  | {
      firstPrefix: string;
      continuationPrefix: string;
      content: string;
      width: number;
    }
  | undefined {
  const plain = stripAnsiForPrefix(line);
  const list = plain.match(/^((?:│ )*)( {2}(?:•|\d+[.)]) )/);
  if (list) {
    const quote = list[1] ?? '';
    const marker = list[2] ?? '';
    const first = splitRawAtVisiblePrefix(line, quote.length + marker.length);
    const quotePrefix =
      quote.length > 0
        ? splitRawAtVisiblePrefix(line, quote.length).prefix
        : '';
    return {
      firstPrefix: first.prefix,
      continuationPrefix: `${quotePrefix}${' '.repeat(marker.length)}`,
      content: first.rest,
      width: quote.length + marker.length,
    };
  }

  const quote = plain.match(/^((?:│ )+)/);
  if (quote) {
    const prefixWidth = quote[1]?.length ?? 0;
    const first = splitRawAtVisiblePrefix(line, prefixWidth);
    return {
      firstPrefix: first.prefix,
      continuationPrefix: first.prefix,
      content: first.rest,
      width: prefixWidth,
    };
  }

  return undefined;
}

function wrapMarkdownPrefixedLine(line: string, columns: number): string {
  const prefix = markdownContinuationPrefix(line);
  if (!prefix) return wrapLine(line, columns);
  const contentWidth = Math.max(MIN_WRAP_WIDTH, columns - prefix.width);
  const wrapped = wrapLine(prefix.content, contentWidth).split('\n');
  return wrapped
    .map((part, index) =>
      index === 0
        ? `${prefix.firstPrefix}${part}`
        : `${prefix.continuationPrefix}${part}`,
    )
    .join('\n');
}

function wrapLine(line: string, columns: number): string {
  return wrapAnsi(line, columns, {
    hard: true,
    trim: false,
  });
}

export function wrapAnsiToWidth(
  text: string,
  width?: number,
  options: WrapAnsiOptions = {},
): string {
  const columns = normalizedWidth(width);
  if (columns == null) return text;

  return text
    .split('\n')
    .map((line) =>
      options.preserveMarkdownPrefix
        ? wrapMarkdownPrefixedLine(line, columns)
        : wrapLine(line, columns),
    )
    .join('\n');
}
