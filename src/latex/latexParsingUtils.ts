/**
 * Shared LaTeX content parsing utilities.
 *
 * Common patterns used by both extractBibliography.ts and
 * extractFileDependencies.ts for comment stripping and
 * bibliography directive matching.
 */

/** Strips everything after an unescaped % on each line. */
const COMMENT_PATTERN = /(^|[^\\])%.*$/gm;

export function stripLatexComments(content: string): string {
  return content.replaceAll(COMMENT_PATTERN, '$1');
}

/**
 * Matches both \bibliography{...} and \addbibresource[...]{...}.
 * matchAll clones the regex, so a single module-level instance is safe.
 */
export const BIB_DIRECTIVE_PATTERN = new RegExp(
  '(?:bibliography|addbibresource)(?:\\s*\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}',
  'g',
);
