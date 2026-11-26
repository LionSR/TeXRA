/**
 * Shared LaTeX content parsing utilities: comment stripping, bibliography
 * directive matching, and the path resolution the LaTeX dependency
 * extractors share.
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

/**
 * Match `pattern` (global, with one capture group: both callers pass a
 * module constant) against `content` and split each match's group on
 * commas, trimming and de-duplicating the resulting tokens (empty entries
 * are skipped). `transform` maps each trimmed token before adding it to the
 * result set, so callers can resolve tokens to paths or leave them as plain
 * keys.
 */
function collectCommaSeparatedMatches(
  content: string,
  pattern: RegExp,
  transform: (token: string) => string = (token) => token,
): string[] {
  const tokens = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    for (const raw of match[1].split(',')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      tokens.add(transform(trimmed));
    }
  }
  return [...tokens];
}

const USEPACKAGE_PATTERN =
  /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

/** The packages `\usepackage` and `\RequirePackage` load in `content`,
 *  whatever options they take. */
export function loadedPackages(content: string): string[] {
  return collectCommaSeparatedMatches(content, USEPACKAGE_PATTERN);
}

const DOCUMENTCLASS_PATTERN = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/;

/** The class `\documentclass` names in `content`, whatever options it
 *  takes; `undefined` when there is none. */
export function documentClass(content: string): string | undefined {
  return DOCUMENTCLASS_PATTERN.exec(content)?.[1]?.trim();
}
