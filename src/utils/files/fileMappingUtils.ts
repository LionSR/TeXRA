// Standard library imports
import * as path from 'path';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';

// Local file imports
import { flexibleFS } from './flexibleFS';
import { pathToLocation } from './taskRunStorage';
import type { FileLocation } from './taskRunStorage';

/**
 * Create a mapping between two file lists based on name similarity.
 * Returns FileLocation → FileLocation map (no string conversions).
 *
 * @param sourceFiles The source file locations
 * @param targetFiles The target file locations
 * @param matchStrategy 'basename' for exact basename matching or 'contains' for substring matching
 * @param roundAware Ignore round numbers in filenames when true
 * @returns Map of source FileLocations to their best matching target FileLocations
 */
export function createFileMapping(
  sourceFiles: FileLocation[],
  targetFiles: FileLocation[],
  matchStrategy: 'basename' | 'contains' = 'basename',
  roundAware: boolean = false,
): Map<FileLocation, FileLocation> {
  const fileMapping = new Map<FileLocation, FileLocation>();

  if (sourceFiles.length === 0 || targetFiles.length === 0) {
    return fileMapping;
  }

  for (const target of targetFiles) {
    const targetPath =
      target.kind !== 'external' ? target.relativePath : target.absolutePath;
    const targetBaseName = path.basename(targetPath);

    let bestMatchSource: FileLocation | null = null;
    let bestMatchScore = 0;

    for (const sourceFile of sourceFiles) {
      if (!sourceFile) {
        continue;
      }

      // Both workspace and runStorage have relativePath; external uses absolutePath
      const sourcePath =
        sourceFile.kind !== 'external'
          ? sourceFile.relativePath
          : sourceFile.absolutePath;
      const sourceBaseName = path.basename(sourcePath);

      const sourceName = path.parse(sourceBaseName).name;
      const targetName = path.parse(targetBaseName).name;

      const sourceNameNormalized = roundAware
        ? sourceName.split('_r')[0]
        : sourceName;
      const targetNameNormalized = roundAware
        ? targetName.split('_r')[0]
        : targetName;

      let isMatch = false;
      let matchScore = 0;

      if (matchStrategy === 'basename') {
        isMatch = sourceNameNormalized === targetNameNormalized;
        matchScore = isMatch ? sourceNameNormalized.length : 0;
      } else if (matchStrategy === 'contains') {
        isMatch = targetBaseName.includes(sourceName);
        matchScore = isMatch ? sourceName.length : 0;
      }

      if (isMatch && matchScore > bestMatchScore) {
        bestMatchScore = matchScore;
        bestMatchSource = sourceFile;
      }
    }

    if (bestMatchSource) {
      fileMapping.set(bestMatchSource, target);
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

function normalizeLatexPath(value: string): string {
  if (!value) {
    return value;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, '/'));
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function hasTexExtension(value: string): boolean {
  return TEX_EXTENSION_REGEX.test(value);
}

function removeTexExtension(value: string): string {
  return value.replace(TEX_EXTENSION_REGEX, '');
}

function getPathSegments(filePath: string): string[] {
  return path
    .normalize(filePath)
    .split(path.sep)
    .filter((segment) => segment !== '');
}

function buildReplacementLookup(
  baseToOutputMap: Map<FileLocation, FileLocation>,
): Map<string, string> {
  const replacements = new Map<string, string>();

  const registerReplacement = (source: string, target: string) => {
    const normalizedSource = normalizeLatexPath(source);
    const normalizedTarget = normalizeLatexPath(target);

    if (!normalizedSource || replacements.has(normalizedSource)) {
      return;
    }

    replacements.set(normalizedSource, normalizedTarget);
  };

  for (const [baseLoc, outputLoc] of baseToOutputMap.entries()) {
    if (!baseLoc || !outputLoc) {
      continue;
    }

    const baseFile =
      baseLoc.kind !== 'external' ? baseLoc.relativePath : baseLoc.absolutePath;
    const outputFile =
      outputLoc.kind !== 'external'
        ? outputLoc.relativePath
        : outputLoc.absolutePath;

    const baseSegments = getPathSegments(baseFile);
    const outputSegments = getPathSegments(outputFile);
    const maxDepth = Math.min(baseSegments.length, outputSegments.length);

    for (let depth = maxDepth; depth >= 1; depth--) {
      const baseSuffix = baseSegments.slice(-depth).join('/');
      const outputSuffix = outputSegments.slice(-depth).join('/');

      registerReplacement(baseSuffix, outputSuffix);

      if (hasTexExtension(baseSuffix) && hasTexExtension(outputSuffix)) {
        registerReplacement(
          removeTexExtension(baseSuffix),
          removeTexExtension(outputSuffix),
        );
      }
    }
  }

  return replacements;
}

export async function replaceInputCommands(
  baseFiles: FileLocation[],
  outputFiles: FileLocation[],
  logger?: AgentLogger,
): Promise<void> {
  if (baseFiles.length === 0 || outputFiles.length === 0) {
    logger?.debug('No files to process for input command replacement');
    return;
  }

  // Both workspace and runStorage have relativePath; external uses absolutePath
  const baseFilePaths = baseFiles.map((f) =>
    f.kind !== 'external' ? f.relativePath : f.absolutePath,
  );

  const baseToOutputMap = createFileMapping(baseFiles, outputFiles, 'contains');

  if (baseToOutputMap.size === 0) {
    logger?.debug('No valid file mappings for input command replacement');
    return;
  }

  logger?.debug(
    `File mappings for input replacement: ${Array.from(
      baseToOutputMap.entries(),
    )
      .map(
        ([baseLoc, outputLoc]) =>
          `${path.basename(baseLoc.kind !== 'external' ? baseLoc.relativePath : baseLoc.absolutePath)} -> ${path.basename(outputLoc.kind !== 'external' ? outputLoc.relativePath : outputLoc.absolutePath)}`,
      )
      .join(', ')}`,
  );

  const replacementLookup = buildReplacementLookup(baseToOutputMap);

  if (replacementLookup.size === 0) {
    logger?.debug('No replacement entries derived from file mappings');
    return;
  }

  for (const outputLocation of outputFiles) {
    const outputPath =
      outputLocation.kind !== 'external'
        ? outputLocation.relativePath
        : outputLocation.absolutePath;

    try {
      const content = await flexibleFS.read(outputLocation);
      const newContent = content.replace(
        /\\input{([^}]+)}/g,
        (match, rawPath) => {
          const normalizedPath = normalizeLatexPath(rawPath);

          if (!normalizedPath) {
            return match;
          }

          const replacement = replacementLookup.get(normalizedPath);

          if (replacement) {
            return `\\input{${replacement}}`;
          }

          return match;
        },
      );

      if (newContent !== content) {
        await flexibleFS.write(outputLocation, newContent);
        logger?.debug(`Updated input commands in ${outputPath}`);
      }
    } catch (err) {
      logger?.warn(
        `Error processing input commands in ${outputPath}: ${toErrorMessage(err)}`,
      );
    }
  }
}
