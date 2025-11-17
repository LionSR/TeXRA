// Standard library imports
import * as path from 'path';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';

// Local file imports
import { flexibleFS } from './flexibleFS';
import { pathToLocation } from './taskRunStorage';

/**
 * Create a mapping between two file lists based on name similarity.
 *
 * @param sourceFiles The source file paths
 * @param targetFiles The target file paths
 * @param matchStrategy 'basename' for exact basename matching or 'contains' for substring matching
 * @param roundAware Ignore round numbers in filenames when true
 * @returns Map of source files to their best matching target files
 */
export function createFileMapping(
  sourceFiles: string[],
  targetFiles: string[],
  matchStrategy: 'basename' | 'contains' = 'basename',
  roundAware: boolean = false,
): Map<string, string> {
  const fileMapping = new Map<string, string>();

  if (!sourceFiles?.length || !targetFiles?.length) {
    return fileMapping;
  }

  for (const targetFile of targetFiles) {
    if (!targetFile || typeof targetFile !== 'string') {
      continue;
    }

    const targetBaseName = path.basename(targetFile);

    let bestMatch: string | null = null;
    let bestMatchScore = 0;

    for (const sourceFile of sourceFiles) {
      if (!sourceFile || typeof sourceFile !== 'string') {
        continue;
      }

      const sourceBaseName = path.basename(sourceFile);

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
        bestMatch = sourceFile;
      }
    }

    if (bestMatch) {
      fileMapping.set(bestMatch, targetFile);
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
  baseToOutputMap: Map<string, string>,
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

  for (const [baseFile, outputFile] of baseToOutputMap.entries()) {
    if (!baseFile || !outputFile) {
      continue;
    }

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
  baseFiles: string[],
  outputFiles: string[],
  logger?: AgentLogger,
): Promise<void> {
  if (!baseFiles?.length || !outputFiles?.length) {
    logger?.debug('No files to process for input command replacement');
    return;
  }

  const baseToOutputMap = createFileMapping(baseFiles, outputFiles, 'contains');

  if (baseToOutputMap.size === 0) {
    logger?.debug('No valid file mappings for input command replacement');
    return;
  }

  logger?.debug(
    `File mappings for input replacement: ${Array.from(
      baseToOutputMap.entries(),
    )
      .map(([base, output]) => `${base} -> ${output}`)
      .join(', ')}`,
  );

  const replacementLookup = buildReplacementLookup(baseToOutputMap);

  if (replacementLookup.size === 0) {
    logger?.debug('No replacement entries derived from file mappings');
    return;
  }

  for (const outputFile of outputFiles) {
    if (!outputFile) {
      continue;
    }

    try {
      const content = await flexibleFS.read(pathToLocation(outputFile));
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
        await flexibleFS.write(pathToLocation(outputFile), newContent);
        logger?.debug(`Updated input commands in ${outputFile}`);
      }
    } catch (err) {
      logger?.warn(
        `Error processing input commands in ${outputFile}: ${toErrorMessage(err)}`,
      );
    }
  }
}
