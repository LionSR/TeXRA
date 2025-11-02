// Standard library imports
import * as path from 'path';

// Local imports
import { WorkspaceFS } from './workspaceFS';
import type { ChannelLogger } from '@logger/logUtils';

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
export async function replaceInputCommands(
  baseFiles: string[],
  outputFiles: string[],
  logger?: ChannelLogger,
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
      .map(
        ([base, output]) =>
          `${path.basename(base)} -> ${path.basename(output)}`,
      )
      .join(', ')}`,
  );

  const baseToOutput = new Map<string, string>();
  for (const [baseFile, outputFile] of baseToOutputMap.entries()) {
    baseToOutput.set(path.basename(baseFile), path.basename(outputFile));
  }

  for (const outputFile of outputFiles) {
    if (!outputFile) {
      continue;
    }

    try {
      const content = await WorkspaceFS.read(outputFile);
      const newContent = content.replace(/\\input{([^}]+)}/g, (match, p1) =>
        baseToOutput.has(p1) ? `\\input{${baseToOutput.get(p1)}}` : match,
      );

      if (newContent !== content) {
        await WorkspaceFS.write(outputFile, newContent);
        logger?.debug(`Updated input commands in ${outputFile}`);
      }
    } catch (err) {
      logger?.warn(
        `Error processing input commands in ${outputFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
