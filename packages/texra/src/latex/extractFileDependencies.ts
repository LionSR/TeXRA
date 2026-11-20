/**
 * Extract file dependencies from LaTeX content.
 *
 * Parses \input{}, \include{}, \bibliography{}, \addbibresource{}, and
 * \usepackage{} commands to discover files that the main document depends on.
 * Used by `processInputFiles` (`latexMedia.ts`) to mirror these dependencies into run storage
 * so that output files can be compiled outside the workspace.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, Predicate } from 'effect';

// Local imports
import type { FileLocation } from '@texra-ai/harness/schemas';

// Local file imports
import {
  collectBibliographyPaths,
  ensureExtension,
  existingExternalPath,
  joinLatexPath,
  LATEX_PROBE_CONCURRENCY,
  loadedPackages,
  readUncommentedLatex,
  resolveLatexDir,
  texInputPaths,
} from './latexParsingUtils';

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
 * Extract file dependencies (\input, \include, \bibliography, \addbibresource,
 * and a \usepackage{name} whose `name.sty` sits beside the file) from a LaTeX
 * file. Returns absolute paths to existing files.
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

  const uncommented = yield* readUncommentedLatex(
    latexFileLocation.absolutePath,
  );

  const bibCandidates = collectBibliographyPaths(latexDir, uncommented);
  const styCandidates = loadedPackages(uncommented).map((name) =>
    path.join(latexDir, `${name}.sty`),
  );

  // The probe sets run as one bounded fan-out under the calling fiber:
  // a failure interrupts the siblings instead of leaving them running behind
  // an all-results aggregate.
  const [texResolved, bibResolved, styResolved] = yield* Effect.all(
    [
      Effect.forEach(
        texInputPaths(uncommented),
        (raw) => resolveTexInputPath(raw, latexDir),
        { concurrency: LATEX_PROBE_CONCURRENCY },
      ),
      Effect.forEach(bibCandidates, existingExternalPath, {
        concurrency: LATEX_PROBE_CONCURRENCY,
      }),
      Effect.forEach(styCandidates, existingExternalPath, {
        concurrency: LATEX_PROBE_CONCURRENCY,
      }),
    ],
    { concurrency: 3 },
  );

  return [
    ...new Set(
      [...texResolved, ...bibResolved, ...styResolved].filter(
        Predicate.isNotNull,
      ),
    ),
  ];
});
