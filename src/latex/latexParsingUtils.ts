/**
 * Shared LaTeX content parsing utilities.
 *
 * Common patterns used by both extractBibliography.ts and
 * extractFileDependencies.ts for comment stripping and
 * bibliography directive matching.
 */

import * as path from 'node:path';

import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { ensureExtension, joinLatexPath } from '@utils/core/pathCore';

const log = createLog('LatexParsing');

/**
 * Every citation macro TeXRA recognizes, natbib and biblatex alike, in both
 * lowercase and sentence-case (`\Citep`) spellings. Single source for the two
 * consumers that used to keep disjoint lists — citation-key extraction
 * (`extractBibliography`) and latexdiff's `--exclude-textcmd`
 * (`diffCommandExecutor`) — where a macro known to one but not the other means
 * either a citation key silently missed or a bibliography marked up as prose.
 *
 * Sentence-case forms are generated, not listed: the ones no package defines
 * (`\Nocite`) are inert in both consumers, an unmatched regex alternative and
 * an unknown `--exclude-textcmd` entry respectively.
 */
const CITATION_COMMAND_STEMS = [
  'cite',
  'citet',
  'citep',
  'citealp',
  'citealt',
  'citeauthor',
  'citeyear',
  'citeyearpar',
  'textcite',
  'parencite',
  'footcite',
  'autocite',
  'supercite',
  'smartcite',
  'nocite',
] as const;

export const LATEX_CITATION_COMMANDS: readonly string[] = Object.freeze([
  ...CITATION_COMMAND_STEMS,
  ...CITATION_COMMAND_STEMS.map(
    (name) => `${name[0].toUpperCase()}${name.slice(1)}`,
  ),
]);

/** Strips everything after an unescaped % on each line. */
const COMMENT_PATTERN = /(^|[^\\])%.*$/gm;

export function stripLatexComments(content: string): string {
  return content.replaceAll(COMMENT_PATTERN, '$1');
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
export async function resolveLatexDir(absolutePath: string): Promise<string> {
  const resolved = await platform()
    .fs.realPath(absolutePath)
    .catch((error: unknown) => {
      log.debug(
        `realPath failed for ${absolutePath}; falling back to literal dirname`,
        { data: error },
      );
      return absolutePath;
    });
  return path.dirname(resolved);
}

/**
 * Return `absolutePath` if it exists on disk, otherwise null. Centralizes
 * the `AbsoluteFS.exists(...)` boilerplate used by the various LaTeX
 * dependency resolvers.
 */
export async function existingExternalPath(
  absolutePath: string,
): Promise<string | null> {
  if (await AbsoluteFS.exists(absolutePath)) {
    return absolutePath;
  }
  return null;
}

/**
 * Search `searchPaths × extensions` for the first existing file and return
 * its normalized absolute path, or null if nothing exists.
 *
 * - `relativePath` is joined against each entry in `searchPaths`.
 * - Each `extensions` entry is appended to the joined path; pass `''` to test
 *   the path as-is.
 * - The search is ordered: outer loop over `searchPaths`, inner over
 *   `extensions`. The first hit wins.
 */
export async function findExistingLatexPath(
  relativePath: string,
  searchPaths: string[],
  extensions: string[],
): Promise<string | null> {
  for (const basePath of searchPaths) {
    const joined = path.normalize(path.join(basePath, relativePath));
    for (const ext of extensions) {
      const hit = await existingExternalPath(ext ? `${joined}${ext}` : joined);
      if (hit !== null) return hit;
    }
  }
  return null;
}

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
