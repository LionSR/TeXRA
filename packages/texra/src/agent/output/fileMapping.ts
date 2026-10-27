import * as path from 'node:path';
import { getPathSegments, toPosixPath } from '@texra-ai/harness';

import { Effect, FileSystem } from 'effect';

import {
  toErrorMessage,
  fileLocationDisplayPath,
  type FileLocation,
} from '@texra-ai/harness/schemas';

import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';

import { findMatchingBaseFile } from './lineageMapping';
import type { AgentTrace } from '@texra-ai/harness/plugins';

/** A LaTeX `\input` path trimmed, with POSIX separators and `.`/`..` resolved. */
function normalizeLatexPath(value: string): string {
  const trimmed = value.trim();
  return trimmed ? toPosixPath(trimmed) : '';
}

const TEX_EXTENSION_REGEX = /\.tex$/i;

/**
 * Update \input commands in output files to reference new file paths.
 *
 * Each output is paired with the base file its model-reported `source` names
 * (the matcher lineage tracing uses), so two bases that share a file name in
 * different directories each keep their own output.
 *
 * @param baseFiles Base file paths
 * @param outputs The round's outputs with their reported sources
 * @param logger Optional logger for debug messages
 */
export const replaceInputCommands = Effect.fn('documents.replaceInputCommands')(
  function* (
    baseFiles: FileLocation[],
    outputs: readonly Pick<OutputFileInfo, 'source' | 'location'>[],
    logger?: AgentTrace,
  ): Effect.fn.Return<void, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    if (baseFiles.length === 0 || outputs.length === 0) {
      logger?.debug('No files to process for input command replacement');
      return;
    }

    const baseToOutputMap = new Map<string, FileLocation>();
    for (const { source, location } of outputs) {
      const base = findMatchingBaseFile(baseFiles, source);
      if (base) baseToOutputMap.set(fileLocationDisplayPath(base), location);
    }

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
      outputs,
      ({ location: outputLocation }) => {
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
