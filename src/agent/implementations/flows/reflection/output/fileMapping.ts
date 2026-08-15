// Node imports
import * as path from 'node:path';

// Local imports
import type { AgentTrace } from '@agent/trace/AgentTrace';
import type { FileLocation } from '@shared/schemas';
import { normalizeLatexPath, getPathSegments } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { getComparablePath } from '@utils/files/fileLocation';

/**
 * Create a mapping between two file lists based on name similarity.
 * Uses string keys (comparable paths) for robust lookups, FileLocation values for data.
 * This ensures lookups work even when FileLocation objects are reconstructed.
 *
 * @param sourceFiles The source file locations
 * @param targetFiles The target file locations
 * @param matchStrategy 'basename' for exact basename matching or 'contains' for substring matching
 * @param roundAware Ignore round numbers in filenames when true
 * @returns Map from source path to target FileLocation
 */
export function createFileMapping(
  sourceFiles: FileLocation[],
  targetFiles: FileLocation[],
  matchStrategy: 'basename' | 'contains' = 'basename',
  roundAware = false,
): Map<string, FileLocation> {
  const fileMapping = new Map<string, FileLocation>();

  if (sourceFiles.length === 0 || targetFiles.length === 0) {
    return fileMapping;
  }

  for (const target of targetFiles) {
    const targetPath = getComparablePath(target);
    const targetBaseName = path.basename(targetPath);
    const targetName = path.parse(targetBaseName).name;
    const targetNameNormalized = roundAware
      ? targetName.split('_r')[0]
      : targetName;

    let bestMatchSourcePath: string | null = null;
    let bestMatchScore = 0;

    for (const sourceFile of sourceFiles) {
      const sourcePath = getComparablePath(sourceFile);
      const sourceName = path.parse(path.basename(sourcePath)).name;
      const sourceNameNormalized = roundAware
        ? sourceName.split('_r')[0]
        : sourceName;

      let matchScore = 0;
      if (matchStrategy === 'basename') {
        if (sourceNameNormalized === targetNameNormalized) {
          matchScore = sourceNameNormalized.length;
        }
      } else if (targetBaseName.includes(sourceName)) {
        matchScore = sourceName.length;
      }

      if (matchScore > bestMatchScore) {
        bestMatchScore = matchScore;
        bestMatchSourcePath = sourcePath;
      }
    }

    if (bestMatchSourcePath) {
      fileMapping.set(bestMatchSourcePath, target);
    }
  }

  return fileMapping;
}

/**
 * Update \input commands in output files to reference new file paths.
 *
 * @param baseFiles Base file paths
 * @param outputFiles Output file paths
 * @param logger Optional logger for debug messages
 */
const TEX_EXTENSION_REGEX = /\.tex$/i;

export async function replaceInputCommands(
  baseFiles: FileLocation[],
  outputFiles: FileLocation[],
  logger?: AgentTrace,
): Promise<void> {
  if (baseFiles.length === 0 || outputFiles.length === 0) {
    logger?.debug('No files to process for input command replacement');
    return;
  }

  const baseToOutputMap = createFileMapping(baseFiles, outputFiles, 'contains');

  if (baseToOutputMap.size === 0) {
    logger?.debug('No valid file mappings for input command replacement');
    return;
  }

  logger?.debug(
    `File mappings for input replacement: ${[...baseToOutputMap.entries()]
      .map(
        ([basePath, outputLoc]) =>
          `${path.basename(basePath)} -> ${path.basename(getComparablePath(outputLoc))}`,
      )
      .join(', ')}`,
  );

  // Build replacement lookup: generates all path suffix variants for flexible matching
  const replacementLookup = new Map<string, string>();
  for (const [baseFile, outputLoc] of baseToOutputMap) {
    const outputFile = getComparablePath(outputLoc);
    const baseSegments = getPathSegments(baseFile);
    const outputSegments = getPathSegments(outputFile);
    const maxDepth = Math.min(baseSegments.length, outputSegments.length);

    for (let depth = maxDepth; depth >= 1; depth--) {
      const baseSuffix = baseSegments.slice(-depth).join('/');
      const outputSuffix = outputSegments.slice(-depth).join('/');

      // Register replacement if not already present
      const normalizedBase = normalizeLatexPath(baseSuffix);
      if (normalizedBase && !replacementLookup.has(normalizedBase)) {
        replacementLookup.set(normalizedBase, normalizeLatexPath(outputSuffix));
      }

      // Also register without .tex extension
      const baseHasTex = TEX_EXTENSION_REGEX.test(baseSuffix);
      const outputHasTex = TEX_EXTENSION_REGEX.test(outputSuffix);
      if (baseHasTex && outputHasTex) {
        const baseNoExt = normalizeLatexPath(
          baseSuffix.replace(TEX_EXTENSION_REGEX, ''),
        );
        if (baseNoExt && !replacementLookup.has(baseNoExt)) {
          replacementLookup.set(
            baseNoExt,
            normalizeLatexPath(outputSuffix.replace(TEX_EXTENSION_REGEX, '')),
          );
        }
      }
    }
  }

  if (replacementLookup.size === 0) {
    logger?.debug('No replacement entries derived from file mappings');
    return;
  }

  for (const outputLocation of outputFiles) {
    const outputPath = getComparablePath(outputLocation);

    try {
      const content = await AbsoluteFS.read(outputLocation.absolutePath);
      const newContent = content.replaceAll(
        /\\input{([^}]+)}/g,
        (match, rawPath) => {
          const normalizedPath = normalizeLatexPath(rawPath);
          const replacement = normalizedPath
            ? replacementLookup.get(normalizedPath)
            : undefined;
          return replacement ? `\\input{${replacement}}` : match;
        },
      );

      if (newContent !== content) {
        await AbsoluteFS.write(outputLocation.absolutePath, newContent);
        logger?.debug(`Updated input commands in ${outputPath}`);
      }
    } catch (err) {
      logger?.warn(
        `Error processing input commands in ${outputPath}: ${toErrorMessage(err)}`,
      );
    }
  }
}
