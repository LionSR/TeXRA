import * as path from 'node:path';
import { getPathSegments, toPosixPath } from '@texra-ai/harness/host';

import { Effect, FileSystem } from 'effect';

import {
  toErrorMessage,
  fileLocationDisplayPath,
  type FileLocation,
} from '@texra-ai/harness/schemas';
import type { AgentTrace } from '@texra-ai/harness/plugins';

/** A LaTeX `\input` path trimmed, with POSIX separators and `.`/`..` resolved. */
function normalizeLatexPath(value: string): string {
  const trimmed = value.trim();
  return trimmed ? toPosixPath(trimmed) : '';
}

/**
 * Map each source file to the target whose file name contains the source's
 * name without its extension, the longest such name winning (`paper` matches
 * `paper_revised.tex`). Uses string keys (comparable paths) for robust
 * lookups, FileLocation values for data, so lookups work even when
 * FileLocation objects are reconstructed.
 *
 * @returns Map from source path to target FileLocation
 */
export function createFileMapping(
  sourceFiles: FileLocation[],
  targetFiles: FileLocation[],
): Map<string, FileLocation> {
  const fileMapping = new Map<string, FileLocation>();

  if (sourceFiles.length === 0 || targetFiles.length === 0) {
    return fileMapping;
  }

  const baseNameOf = (filePath: string): string =>
    path.parse(path.basename(filePath)).name;

  // Source names do not depend on the target, so derive them once up front.
  const sources = sourceFiles.map((sourceFile) => {
    const sourcePath = fileLocationDisplayPath(sourceFile);
    return { sourcePath, sourceName: baseNameOf(sourcePath) };
  });

  for (const target of targetFiles) {
    const targetPath = fileLocationDisplayPath(target);
    const targetBaseName = path.basename(targetPath);

    let bestMatchSourcePath: string | null = null;
    let bestMatchScore = 0;

    for (const { sourcePath, sourceName } of sources) {
      if (
        targetBaseName.includes(sourceName) &&
        sourceName.length > bestMatchScore
      ) {
        bestMatchScore = sourceName.length;
        bestMatchSourcePath = sourcePath;
      }
    }

    if (bestMatchSourcePath) {
      fileMapping.set(bestMatchSourcePath, target);
    }
  }

  return fileMapping;
}

const TEX_EXTENSION_REGEX = /\.tex$/i;

/**
 * Update \input commands in output files to reference new file paths.
 *
 * @param baseFiles Base file paths
 * @param outputFiles Output file paths
 * @param logger Optional logger for debug messages
 */
export const replaceInputCommands = Effect.fn('documents.replaceInputCommands')(
  function* (
    baseFiles: FileLocation[],
    outputFiles: FileLocation[],
    logger?: AgentTrace,
  ): Effect.fn.Return<void, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    if (baseFiles.length === 0 || outputFiles.length === 0) {
      logger?.debug('No files to process for input command replacement');
      return;
    }

    const baseToOutputMap = createFileMapping(baseFiles, outputFiles);

    if (baseToOutputMap.size === 0) {
      logger?.debug('No valid file mappings for input command replacement');
      return;
    }

    logger?.debug(
      `File mappings for input replacement: ${[...baseToOutputMap.entries()]
        .map(
          ([basePath, outputLoc]) =>
            `${path.basename(basePath)} -> ${path.basename(fileLocationDisplayPath(outputLoc))}`,
        )
        .join(', ')}`,
    );

    // Build replacement lookup: generates all path suffix variants for flexible matching.
    // First registration of a normalized path wins (longest suffix first).
    const replacementLookup = new Map<string, string>();
    const register = (baseVariant: string, outputVariant: string): void => {
      const key = normalizeLatexPath(baseVariant);
      if (key && !replacementLookup.has(key)) {
        replacementLookup.set(key, normalizeLatexPath(outputVariant));
      }
    };

    for (const [baseFile, outputLoc] of baseToOutputMap) {
      const outputFile = fileLocationDisplayPath(outputLoc);
      const baseSegments = getPathSegments(baseFile);
      const outputSegments = getPathSegments(outputFile);
      const maxDepth = Math.min(baseSegments.length, outputSegments.length);

      for (let depth = maxDepth; depth >= 1; depth--) {
        const baseSuffix = baseSegments.slice(-depth).join('/');
        const outputSuffix = outputSegments.slice(-depth).join('/');

        register(baseSuffix, outputSuffix);

        // Also register without .tex extension
        if (
          TEX_EXTENSION_REGEX.test(baseSuffix) &&
          TEX_EXTENSION_REGEX.test(outputSuffix)
        ) {
          register(
            baseSuffix.replace(TEX_EXTENSION_REGEX, ''),
            outputSuffix.replace(TEX_EXTENSION_REGEX, ''),
          );
        }
      }
    }

    if (replacementLookup.size === 0) {
      logger?.debug('No replacement entries derived from file mappings');
      return;
    }

    // Each output is its own file, so they are rewritten concurrently.
    yield* Effect.forEach(
      outputFiles,
      (outputLocation) => {
        const outputPath = fileLocationDisplayPath(outputLocation);

        return Effect.gen(function* () {
          const content = (yield* fs.readFileString(
            outputLocation.absolutePath,
          )).replaceAll('\r\n', '\n');
          const newContent = content.replaceAll(
            /\\input{([^}]+)}/g,
            (match, rawPath) => {
              // `register` never stores an empty key, so an empty path misses.
              const replacement = replacementLookup.get(
                normalizeLatexPath(rawPath),
              );
              return replacement ? `\\input{${replacement}}` : match;
            },
          );

          if (newContent !== content) {
            yield* fs.writeFileString(outputLocation.absolutePath, newContent);
            logger?.debug(`Updated input commands in ${outputPath}`);
          }
        }).pipe(
          // One unreadable or unwritable output must not stop the rewrite of the
          // rest; the file keeps its original `\input{}` targets and says so.
          Effect.catch((err) =>
            Effect.sync(() => {
              logger?.warn(
                `Error processing input commands in ${outputPath}: ${toErrorMessage(err)}`,
              );
            }),
          ),
        );
      },
      { concurrency: 8, discard: true },
    );
  },
);
