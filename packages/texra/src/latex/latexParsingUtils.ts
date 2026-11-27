/**
 * LaTeX content parsing: comment stripping, and the packages and class a
 * document loads.
 */

import { Effect, FileSystem } from 'effect';

import { readNormalizedFile } from '@texra-ai/worldline/node';

/**
 * A comment, or a URL argument to keep whole. A `%` starts a comment unless
 * an odd number of backslashes precedes it (`\%` is a percent sign, `\\%` a
 * line break and then a comment). Inside the argument of `\url`, `\path`,
 * `\nolinkurl` and the first argument of `\href`, a `%` is part of the URL.
 *
 * A comment runs through its line break and the indentation of the next
 * line, as TeX reads it: `micro%` above `scope` is `microscope`. Before a
 * blank line it stops at the line break, which is the blank line's paragraph
 * break to keep, and so it does right after a control word, whose name the
 * line break ends: joining `\alpha%` to `x` would make `\alphax`.
 */
const COMMENT_PATTERN =
  /(?<=(?<!\\)(?:\\\\)*)(?:(\\(?:url|nolinkurl|path|href)\s*\{[^{}\n]*\})|(?<=(?<!\\)(?:\\\\)*\\[A-Za-z@]+)%.*|%.*(?:\n[ \t]*(?=\S))?)/g;

/**
 * The text of the LaTeX file at `absolutePath` with each comment removed, so
 * nothing commented out reads as a figure, input, bibliography or picture the
 * document uses, and what remains compiles as the file does.
 */
export const readUncommentedLatex = Effect.fn('latex.readUncommentedLatex')(
  function* (absolutePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* readNormalizedFile(fs, absolutePath);
    return content.replaceAll(
      COMMENT_PATTERN,
      (_match, url: string | undefined) => url ?? '',
    );
  },
);

const USEPACKAGE_PATTERN =
  /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

/** The packages `\usepackage` and `\RequirePackage` load in `content`,
 *  whatever options they take: each comma-separated name once, trimmed,
 *  empty entries skipped. */
export function loadedPackages(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(USEPACKAGE_PATTERN)) {
    for (const raw of match[1].split(',')) {
      const trimmed = raw.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return [...names];
}

const DOCUMENTCLASS_PATTERN = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/;

/** The class `\documentclass` names in `content`, whatever options it
 *  takes; `undefined` when there is none. */
export function documentClass(content: string): string | undefined {
  return DOCUMENTCLASS_PATTERN.exec(content)?.[1]?.trim();
}
