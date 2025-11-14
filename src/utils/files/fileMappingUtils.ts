// Standard library imports
import * as path from 'path';

// Local imports
import { AgentLogger } from '@logger/AgentLogger';

// Local file imports
import { flexibleFS } from './flexibleFS';

const INPUT_COMMAND_PATTERN = /\\input\s*{([^}]+)}/g;

const toPosix = (target: string): string => target.replace(/\+/g, '/');

const stripExtension = (target: string): string => {
  const ext = path.posix.extname(target);
  return ext.length > 0 ? target.slice(0, -ext.length) : target;
};

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
      .map(([base, output]) => {
        const normalizedBase = toPosix(flexibleFS.toWorkspaceRelative(base));
        const normalizedOutput = toPosix(
          flexibleFS.toWorkspaceRelative(output),
        );
        return `${normalizedBase} -> ${normalizedOutput}`;
      })
      .join(', ')}`,
  );

  const baseToOutput = new Map<string, string>();
  const registerMapping = (key: string | undefined, value: string) => {
    if (!key) {
      return;
    }

    const trimmed = key.trim();
    if (trimmed.length === 0) {
      return;
    }

    const normalizedValue = value.trim();
    if (normalizedValue.length === 0) {
      return;
    }

    baseToOutput.set(trimmed, normalizedValue);
  };

  for (const [baseFile, outputFile] of baseToOutputMap.entries()) {
    const workspaceBase = toPosix(
      flexibleFS.toWorkspaceRelative(baseFile ?? ''),
    );
    const workspaceOutput = toPosix(
      flexibleFS.toWorkspaceRelative(outputFile ?? ''),
    );

    if (!workspaceBase || !workspaceOutput) {
      continue;
    }

    const baseWithoutExt = stripExtension(workspaceBase);
    const baseName = path.posix.basename(workspaceBase);
    const baseNameWithoutExt = stripExtension(baseName);

    const variants = new Set([
      workspaceBase,
      baseWithoutExt,
      baseName,
      baseNameWithoutExt,
    ]);

    for (const variant of variants) {
      registerMapping(variant, workspaceOutput);
    }
  }

  for (const outputFile of outputFiles) {
    if (!outputFile) {
      continue;
    }

    try {
      const content = await flexibleFS.read(outputFile);
      const newContent = content.replace(
        INPUT_COMMAND_PATTERN,
        (match, rawTarget: string) => {
          const normalized = toPosix(rawTarget.trim());
          if (!normalized) {
            return match;
          }

          const targetWithExt = normalized.endsWith('.tex')
            ? normalized
            : `${normalized}.tex`;

          const candidates = [
            targetWithExt,
            normalized,
            path.posix.basename(targetWithExt),
            path.posix.basename(normalized),
          ];

          for (const candidate of candidates) {
            const replacement = baseToOutput.get(candidate);
            if (replacement) {
              return `\\input{${replacement}}`;
            }
          }

          return match;
        },
      );

      if (newContent !== content) {
        await flexibleFS.write(outputFile, newContent);
        logger?.debug(`Updated input commands in ${outputFile}`);
      }
    } catch (err) {
      logger?.warn(
        `Error processing input commands in ${outputFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
