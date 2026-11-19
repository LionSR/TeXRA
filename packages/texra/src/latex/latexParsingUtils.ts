/**
 * Shared LaTeX content parsing utilities: comment stripping, bibliography
 * directive matching, and the path resolution the LaTeX dependency
 * extractors share.
 */

import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { withLogChannel } from '@texra-ai/harness/plugins';
import { pathExists, readNormalizedFile } from '@texra-ai/harness/node';
import { ensureError, hasExtension } from '@texra-ai/harness/schemas';

const CHANNEL = 'LatexParsing';

/**
 * Join a base directory with a path from a LaTeX command, stripping its
 * leading and trailing slashes. An absolute path is kept, only normalized.
 *
 * @example
 * joinLatexPath('/project', 'figures/image.pdf') // '/project/figures/image.pdf'
 * joinLatexPath('/project', '/abs/refs') // '/abs/refs'
 */
export function joinLatexPath(baseDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) return path.normalize(relativePath);
  const stripped = relativePath.replaceAll(/^\/+|\/+$/g, '');
  return path.normalize(path.join(baseDir, stripped));
}

/**
 * `filePath` with `extension` appended unless it already has it, compared
 * case-insensitively (`refs` and `refs.BIB` both stay one `.bib` file).
 */
export function ensureExtension(filePath: string, extension: string): string {
  if (!filePath) return '';
  return hasExtension(filePath, extension)
    ? filePath
    : `${filePath}${extension}`;
}

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

/** The reads of a LaTeX file's references probe the filesystem, so each
 *  bounds its fan-out to this many at once. */
export const LATEX_PROBE_CONCURRENCY = 8;

/**
 * The text of the LaTeX file at `absolutePath` with each comment removed, so
 * nothing commented out reads as a figure, input, bibliography or picture the
 * document uses, and what remains compiles as the file does.
 */
export const readUncommentedLatex = Effect.fn('latex.readUncommentedLatex')(
  function* (absolutePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* readNormalizedFile(fs, absolutePath).pipe(
      Effect.mapError(ensureError),
    );
    return content.replaceAll(
      COMMENT_PATTERN,
      (_match, url: string | undefined) => url ?? '',
    );
  },
);

/** `\input{…}` or `\include{…}`: the command, then the file it names. */
const TEX_INPUT = String.raw`\\(input|include)\s*\{([^}]+)\}`;

/** A comment (kept whole, so nothing in it counts) or a file input. */
const TEX_INPUT_OR_COMMENT_PATTERN = new RegExp(
  `${COMMENT_PATTERN.source}|${TEX_INPUT}`,
  'g',
);

/**
 * The file arguments of the `\input` and `\include` commands in `content`,
 * in document order, skipping commented-out ones.
 */
export function texInputPaths(content: string): string[] {
  return [...content.matchAll(TEX_INPUT_OR_COMMENT_PATTERN)].flatMap((match) =>
    match[3] === undefined ? [] : [match[3]],
  );
}

/**
 * `content` with the file argument of each `\input` and `\include` replaced
 * by what `rewrite` answers for it; an argument it answers `undefined` for,
 * and every commented-out command, stays as written.
 */
export function rewriteTexInputs(
  content: string,
  rewrite: (rawPath: string) => string | undefined,
): string {
  return content.replaceAll(
    TEX_INPUT_OR_COMMENT_PATTERN,
    (
      match,
      _url: string | undefined,
      command: string | undefined,
      rawPath: string | undefined,
    ) => {
      if (command === undefined || rawPath === undefined) return match;
      const replacement = rewrite(rawPath);
      return replacement === undefined ? match : `\\${command}{${replacement}}`;
    },
  );
}

/**
 * Matches both \bibliography{...} and \addbibresource[...]{...}.
 * matchAll clones the regex, so a single module-level instance is safe.
 */
const BIB_DIRECTIVE_PATTERN = new RegExp(
  '(?:bibliography|addbibresource)(?:\\s*\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}',
  'g',
);

/**
 * Directory containing a LaTeX file, following symlinks so references
 * inside a file mirrored into run storage resolve against the workspace.
 * Falls back to the literal dirname if the file can't be realpath'd.
 */
export const resolveLatexDir = Effect.fn('latex.resolveLatexDir')(function* (
  absolutePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const resolved = yield* Effect.catch(fs.realPath(absolutePath), (error) =>
    Effect.logDebug(
      `realPath failed for ${absolutePath}; falling back to literal dirname`,
    ).pipe(
      Effect.annotateLogs({ data: error }),
      withLogChannel(CHANNEL),
      Effect.as(absolutePath),
    ),
  );
  return path.dirname(resolved);
});

/**
 * Return `absolutePath` if it exists on disk, otherwise null. Centralizes
 * the existence probe used by the various LaTeX dependency resolvers:
 * `pathExists`'s reading, which is ENOTDIR read as absent alongside ENOENT plus
 * a link that resolves to nothing read as absent -- right for a dependency,
 * which a dangling symlink does not supply.
 */
export const existingExternalPath = Effect.fn('latex.existingExternalPath')(
  function* (absolutePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* pathExists(fs, absolutePath).pipe(
      Effect.mapError(ensureError),
    );
    return exists ? absolutePath : null;
  },
);

/**
 * Match `pattern` against `content` and split each match's first capture
 * group on commas, trimming and de-duplicating the resulting tokens (empty
 * entries are skipped). `transform` maps each trimmed token before adding it
 * to the result set, so callers can resolve tokens to paths or leave them as
 * plain keys.
 */
export function collectCommaSeparatedMatches(
  content: string,
  pattern: RegExp,
  transform: (token: string) => string = (token) => token,
): string[] {
  if (!pattern.global) {
    throw new Error(
      'collectCommaSeparatedMatches requires a global RegExp pattern; add the g flag.',
    );
  }

  const tokens = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    const rawGroup = match[1];
    if (rawGroup == null) {
      throw new Error(
        'collectCommaSeparatedMatches requires the pattern to provide a first capture group.',
      );
    }
    for (const raw of rawGroup.split(',')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      tokens.add(transform(trimmed));
    }
  }
  return [...tokens];
}

/**
 * Collect candidate `.bib` paths referenced by `\bibliography` and
 * `\addbibresource` directives in `content`, joined against `baseDir`.
 * Empty/whitespace entries are skipped and duplicates are de-duplicated.
 * Existence checking is the caller's responsibility.
 */
export function collectBibliographyPaths(
  baseDir: string,
  content: string,
): string[] {
  return collectCommaSeparatedMatches(content, BIB_DIRECTIVE_PATTERN, (token) =>
    joinLatexPath(baseDir, ensureExtension(token, '.bib')),
  );
}
