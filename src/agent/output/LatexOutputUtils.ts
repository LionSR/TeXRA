import * as path from 'path';

import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { runLatexFormatter } from '@latex/texFormatter';
import { WorkspaceFS, type FileLocation } from '@utils/files';
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
  const workspaceRoot = WorkspaceFS.getPath();
  if (!fileLocation || !workspaceRoot || fileLocation.kind !== 'workspace') {
    return;
  }
  const workspaceAbsolute = fileLocation.absolutePath;

  const { dir, base } = path.parse(workspaceAbsolute);
  const backupCandidates = [
    path.join(dir, `${base}.bak`),
    path.join(dir, `${base}.bak0`),
    path.join(dir, `${base}.bak1`),
    path.join(dir, 'indent.log'),
  ];

  for (const candidateAbsolute of backupCandidates) {
    const relative = path.relative(workspaceRoot, candidateAbsolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }

    try {
      if (await WorkspaceFS.exists(relative)) {
        await WorkspaceFS.delete(relative);
        logger.debug(`Removed latexindent backup ${relative}`);
      }
    } catch (error) {
      logger.debug(
        `Failed to remove latexindent backup ${relative}: ${toErrorMessage(error)}`,
      );
    }
  }
}
