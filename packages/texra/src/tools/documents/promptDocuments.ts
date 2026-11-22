/**
 * The documents a revision's prompt quotes: each file the run's launch names,
 * read and wrapped in one `<document name>` envelope under the name the
 * reply is asked to use for it.
 */
import { basename, isAbsolute, join } from 'node:path';

import { Effect, FileSystem, Predicate } from 'effect';

import { pathToLocationIn } from '@texra-ai/worldline/plugins';
import { readNormalizedFile } from '@texra-ai/worldline/node';

/**
 * The name a prompt shows a file by, which the reply's documents take.
 *
 * Keep workspace files workspace-relative so sibling documents with the same
 * basename remain distinct. For external absolute paths, expose only the
 * basename: model-produced document names must be portable run-storage names,
 * not host filesystem paths.
 *
 * `workspaceRoot` is the root the caller holds as data. `undefined` is a
 * session with no folder open: every path is then external, so the basename
 * rule applies on its own.
 */
function getPromptFileName(
  workspaceRoot: string | undefined,
  file: string,
): string {
  const location = pathToLocationIn(workspaceRoot, file);
  if (location.kind === 'workspace') return location.relativePath;
  return isAbsolute(file) ? basename(file) : file;
}

/** One document of a prompt, under the name it is quoted by. */
export const promptDocument = (name: string, content: string): string =>
  `<document name="${name}">\n${content}\n</document>`;

/** A file read for the prompt: as the launch named it, the name the prompt
 *  shows it by, and its content. */
interface PromptFile {
  readonly file: string;
  readonly name: string;
  readonly content: string;
}

/** The prompt XML built from a file list, plus what the read dropped. */
interface PromptFilesRead {
  readonly xml: string | null;
  /** The files that were read, in input order, each with the content the
   *  XML carries. */
  readonly readable: readonly PromptFile[];
  /**
   * Files dropped from the prompt because they could not be read. Order is
   * unspecified — the reads finish concurrently — so do not build on it; each
   * entry names its own file.
   */
  readonly skipped: ReadonlyArray<{ file: string; reason: string }>;
}

/**
 * Read files as prompt XML, each named once and empty entries dropped.
 *
 * Best-effort: a file that cannot be read (moved, renamed, or deleted since the
 * launch) is skipped rather than failing the revision. The skip is reported
 * back in `skipped` so the caller can surface it on the run's own channel.
 *
 * @param workspaceRoot Root a relative entry resolves against, held as data
 * @param files The file paths, as the launch named them
 */
export const readFilesAsPromptXml = Effect.fn(
  'promptDocuments.readFilesAsPromptXml',
)(function* (
  workspaceRoot: string | undefined,
  files: readonly string[],
): Effect.fn.Return<PromptFilesRead, never, FileSystem.FileSystem> {
  const named = [...new Set(files.filter((file) => file.trim() !== ''))];
  if (named.length === 0) return { xml: null, readable: [], skipped: [] };

  const fs = yield* FileSystem.FileSystem;
  const reads = yield* Effect.forEach(
    named,
    (file) => {
      // With no workspace root open a relative entry has nothing to resolve
      // against: that one file is skipped, the readable ones kept (#12803).
      const absolute = isAbsolute(file)
        ? file
        : workspaceRoot
          ? join(workspaceRoot, file)
          : undefined;
      if (absolute === undefined)
        return Effect.succeed({
          document: null,
          skipped: { file, reason: 'Error: Workspace path is not available.' },
        });
      return readNormalizedFile(fs, absolute).pipe(
        Effect.map((content) => ({
          document: {
            file,
            name: getPromptFileName(workspaceRoot, file),
            content,
          },
          skipped: null,
        })),
        Effect.orElseSucceed((err) => ({
          document: null,
          skipped: { file, reason: String(err) },
        })),
      );
    },
    { concurrency: 'unbounded' },
  );

  const readable = reads
    .map((read) => read.document)
    .filter(Predicate.isNotNull);
  return {
    xml:
      readable.length > 0
        ? readable
            .map(({ name, content }) => promptDocument(name, content))
            .join('\n')
        : null,
    readable,
    skipped: reads.map((read) => read.skipped).filter(Predicate.isNotNull),
  };
});
