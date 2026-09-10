/**
 * Extract file dependencies from LaTeX content.
 *
 * Parses \input{}, \include{}, \bibliography{}, and \addbibresource{}
 * commands to discover files that the main document depends on.
 * Used by LatexMediaManager to mirror these dependencies into run storage
 * so that output files can be compiled outside the workspace.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { FileLocation } from '@shared/schemas';
import { filterNotNull, unique } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { ensureError } from '@utils/errors/errorMessage';
import { ensureExtension, joinLatexPath } from '@utils/core/pathCore';

// Local file imports
import {
  collectBibliographyPaths,
  existingExternalPath,
  resolveLatexDir,
  stripLatexComments,
} from './latexParsingUtils';

const INPUT_PATTERN = /\\input\s*\{([^}]+)\}/g;
const INCLUDE_PATTERN = /\\include\s*\{([^}]+)\}/g;

/** Dependency probes hit the filesystem, so bound the fan-out. */
const RESOLVE_CONCURRENCY = 8;

/**
 * Resolve a TeX input path (\input / \include argument) to an existing
 * absolute path. Tries the literal path first, then with `.tex` appended
 * (case-insensitive — `chapter.TEX` is not double-extended). Returns null
 * for empty/whitespace input or when neither candidate exists.
 *
 * Uses `joinLatexPath` (not `path.join`) so leading slashes in TeX paths
 * are stripped and absolute paths are preserved, matching LaTeX's own
 * `\input` resolution.
 */
const resolveTexInputPath = Effect.fn('latex.resolveTexInputPath')(function* (
  rawPath: string,
  baseDir: string,
) {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const absolute = joinLatexPath(baseDir, trimmed);
  const hit = yield* existingExternalPath(absolute);
  if (hit) return hit;

  const withExt = ensureExtension(absolute, '.tex');
  if (withExt === absolute) return null;
  return yield* existingExternalPath(withExt);
});

/**
 * Extract file dependencies (\input, \include, \bibliography, \addbibresource)
 * from a LaTeX file. Returns absolute paths to existing files.
 *
 * Uses resolveLatexDir to follow symlinks so that when the input file lives in
 * run storage (as a symlink to the workspace), dependencies are resolved
 * relative to the original workspace location where they actually exist.
 */
export const extractLatexFileDependencies = Effect.fn(
  'latex.extractLatexFileDependencies',
)(function* (latexFileLocation: FileLocation) {
  // Follow symlinks so run-storage paths resolve against the workspace
  const latexDir = yield* resolveLatexDir(latexFileLocation.absolutePath);

  const content = yield* Effect.tryPromise({
    try: () => AbsoluteFS.read(latexFileLocation.absolutePath),
    catch: ensureError,
  });
  const uncommented = stripLatexComments(content);

  const texInputPaths = [INPUT_PATTERN, INCLUDE_PATTERN].flatMap((pattern) =>
    [...uncommented.matchAll(pattern)].map((match) => match[1]),
  );

  const bibCandidates = collectBibliographyPaths(latexDir, uncommented);

  // The two probe sets run as one bounded fan-out under the calling fiber:
  // a failure interrupts the siblings instead of leaving them running behind
  // a settled aggregate, which is what `stopOnError: false` used to do.
  const [texResolved, bibResolved] = yield* Effect.all(
    [
      Effect.forEach(
        texInputPaths,
        (raw) => resolveTexInputPath(raw, latexDir),
        { concurrency: RESOLVE_CONCURRENCY },
      ),
      Effect.forEach(bibCandidates, existingExternalPath, {
        concurrency: RESOLVE_CONCURRENCY,
      }),
    ],
    { concurrency: 2 },
  );

  return unique([...texResolved, ...bibResolved].filter(filterNotNull));
});
