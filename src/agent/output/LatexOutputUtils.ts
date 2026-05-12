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
