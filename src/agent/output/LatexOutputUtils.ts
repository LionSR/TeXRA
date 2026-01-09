import * as path from 'path';

import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { WorkspaceFS, type FileLocation } from '@utils/files';
import { runLatexFormatter } from '@latex/texFormatter';

interface Logger {
  debug(message: string, options?: { messageType?: string }): void;
}

/** Indent a single LaTeX file for better readability. */
export async function indentLatexFile(
  fileLocation: FileLocation,
  logger: Logger,
): Promise<void> {
  if (!fileLocation.absolutePath.includes('.tex')) {
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
  for (const location of fileLocations) {
    await indentLatexFile(location, logger);
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

  const workspaceRoot = WorkspaceFS.getPath();
  if (!workspaceRoot) {
    return;
  }

  if (fileLocation.kind !== 'workspace') {
    return;
  }
  const workspaceAbsolute = fileLocation.absolutePath;

  const { dir, base, name } = path.parse(workspaceAbsolute);
  const backupCandidates = new Set<string>([
    path.join(dir, `${base}.bak`),
    path.join(dir, `${base}.bak0`),
    path.join(dir, `${base}.bak1`),
    path.join(dir, `${name}.bak`),
    path.join(dir, `${name}.bak0`),
    path.join(dir, `${name}.bak1`),
    path.join(dir, 'indent.log'),
  ]);

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
