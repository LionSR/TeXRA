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

async function tryUnlink(filePath: string, logger: Logger): Promise<void> {
  try {
    await fs.unlink(filePath);
    logger.debug(`Removed latexindent backup ${filePath}`);
  } catch (error) {
    logger.debug(
      `Failed to remove latexindent backup ${filePath}: ${toErrorMessage(error)}`,
    );
  }
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

  // Glob for all .bak* files (covers .bak, .bak0, .bak1, .bak2, etc.)
  const backupFiles = globSync(
    path.join(dir, `${base}.bak*`),
    { nodir: true },
  );

  for (const backupFile of backupFiles) {
    await tryUnlink(backupFile, logger);
  }

  // Clean up indent.log directly (known filename, no glob needed)
  await tryUnlink(path.join(dir, 'indent.log'), logger);
}
