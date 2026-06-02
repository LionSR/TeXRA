import wrapAnsi from 'wrap-ansi';

import {
  ANSI_ESCAPE_START,
  ansiEscapeEnd,
  stripAnsiSequences,
} from '@cli/runtime/ansiEscapes';

const MIN_WRAP_WIDTH = 1;

function normalizedWidth(width: number | undefined): number | undefined {
  if (width == null || !Number.isFinite(width)) return undefined;
  return Math.max(MIN_WRAP_WIDTH, Math.floor(width));
}

function splitRawAtVisiblePrefix(
  line: string,
  visiblePrefixLength: number,
): { prefix: string; rest: string } {
  let visible = 0;
  let index = 0;
  while (index < line.length && visible < visiblePrefixLength) {
    if (line[index] === ANSI_ESCAPE_START) {
      index = ansiEscapeEnd(line, index);
    } else {
      visible += 1;
      index += 1;
    }
  }
  while (line[index] === ANSI_ESCAPE_START) {
    index = ansiEscapeEnd(line, index);
  }
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
  const plain = stripAnsiSequences(line);
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
  preserveMarkdownPrefix = false,
): string {
  const columns = normalizedWidth(width);
  if (columns == null) return text;

  return text
    .split('\n')
    .map((line) =>
      preserveMarkdownPrefix
        ? wrapMarkdownPrefixedLine(line, columns)
        : wrapLine(line, columns),
    )
    .join('\n');
}
