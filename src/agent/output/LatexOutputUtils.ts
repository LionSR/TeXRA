import { promises as fs } from 'fs';
import * as path from 'path';

import { sync as globSync } from 'glob';

import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { runLatexFormatter } from '@latex/texFormatter';
import { type FileLocation } from '@utils/files';
import { hasExtension } from '@utils/core/pathCore';

interface Logger {
  debug(message: string, options?: { messageType?: string }): void;
}

/** Indent a single LaTeX file for better readability. */
export async function indentLatexFile(
  fileLocation: FileLocation,
  logger: Logger,
): Promise<void> {
  if (!hasExtension(fileLocation.absolutePath, '.tex')) {
    return;
  }
  logger.debug(`Formatting ${fileLocation.absolutePath}`);
  await runLatexFormatter(fileLocation.absolutePath);
}

/** Indent multiple LaTeX files for better readability. */
export async function indentLatexFiles(
  fileLocations: FileLocation[],
  logger: Logger,
): Promise<void> {
  await Promise.all(fileLocations.map((loc) => indentLatexFile(loc, logger)));
}

/** Clean up latexindent backup files after formatting. */
export async function cleanupLatexBackups(
  fileLocation: FileLocation | null,
  logger: Logger,
): Promise<void> {
  if (!fileLocation) {
    return;
  }

  const { dir, base } = path.parse(fileLocation.absolutePath);

  // Use glob to find all .bak* files (covers .bak, .bak0, .bak1, .bak2, etc.)
  const backupGlobs = [
    path.join(dir, `${base}.bak*`),
    path.join(dir, 'indent.log'),
  ];

  const candidates = new Set<string>();
  for (const pattern of backupGlobs) {
    for (const match of globSync(pattern, { nodir: true })) {
      candidates.add(match);
    }
  }

  for (const candidate of candidates) {
    try {
      await fs.unlink(candidate);
      logger.debug(`Removed latexindent backup ${candidate}`);
    } catch (error) {
      logger.debug(
        `Failed to remove latexindent backup ${candidate}: ${toErrorMessage(error)}`,
      );
    }
  }
}
