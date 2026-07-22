// Third-party imports
import { globIterate } from 'glob';
import { MODELS } from 'llm-zoo';

// Internal imports
import * as logger from '@logger/logUtils';
import type { FileOpResult } from '@shared/schemas/opResults';
import { EXCLUDED_DIRS } from '@shared/constants/latex';
import { WorkspaceFS } from '@utils/files';
import { unique } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { TEMP_EXTENSIONS, PACK_EXTENSIONS, HISTORY_DIR } from './constants';
import { findFilesFromPatterns, resolveHousekeepingTargets } from './utils';

const CHANNEL = 'Housekeeping';

function toIgnoreGlobs(dirs: Iterable<string>): string[] {
  return [...dirs].map((dir) => `**/${dir}/**`);
}

export async function runCleanSingle(
  model: string,
  inputFile: string,
  agent: string,
): Promise<FileOpResult> {
  logger.info(
    CHANNEL,
    `Starting cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );

  const targets = resolveHousekeepingTargets(model, inputFile, agent);
  if (!targets) {
    return { status: 'missingParams' };
  }
  const { inputDir, filePatterns } = targets;

  const extensions = [...TEMP_EXTENSIONS, ...PACK_EXTENSIONS];
  logger.debug(CHANNEL, `Using extensions: ${extensions}`);

  try {
    let firstFile: string | undefined;
    let deletedFile = false;

    // Preserve the legacy safety rule that a lone match equal to the input
    // document is not deleted, while retaining at most this one deferred path.
    for await (const filePath of findFilesFromPatterns(
      inputDir,
      filePatterns,
      extensions,
    )) {
      if (firstFile === undefined) {
        firstFile = filePath;
        continue;
      }

      if (!deletedFile && filePath === firstFile) {
        continue;
      }

      if (!deletedFile) {
        logger.debug(CHANNEL, `Deleting file: ${firstFile}`);
        await WorkspaceFS.delete(firstFile);
        deletedFile = true;
      }

      logger.debug(CHANNEL, `Deleting file: ${filePath}`);
      await WorkspaceFS.delete(filePath);
      deletedFile = true;
    }

    if (firstFile === undefined || (!deletedFile && firstFile === inputFile)) {
      logger.warn(CHANNEL, `No matching files found to clean for ${inputFile}`);
      return { status: 'noFiles' };
    }

    if (!deletedFile) {
      logger.debug(CHANNEL, `Deleting file: ${firstFile}`);
      await WorkspaceFS.delete(firstFile);
    }

    logger.info(CHANNEL, `Cleanup complete for ${inputFile}`);
    return { status: 'success' };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error during cleanup of ${inputFile}: ${toErrorMessage(err)}`,
    );
    return { status: 'error', error: toErrorMessage(err) };
  }
}

export async function runCleanMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
): Promise<FileOpResult> {
  logger.debug(
    CHANNEL,
    `Starting multiple cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  const firstResult = await runCleanSingle(model, inputFile, agent);
  if (
    firstResult.status === 'missingParams' ||
    firstResult.status === 'error'
  ) {
    return firstResult;
  }
  let anyCleaned = firstResult.status === 'success';

  for (const file of inputFiles) {
    const res = await runCleanSingle(model, file, agent);
    if (res.status === 'error') {
      return res;
    }
    anyCleaned ||= res.status === 'success';
  }

  logger.info(CHANNEL, 'Cleanup complete for multiple files.');
  return anyCleaned ? { status: 'success' } : { status: 'noFiles' };
}

export async function runCleanBuild(): Promise<void> {
  logger.debug(CHANNEL, 'Starting build directory cleanup');

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return;
  }

  const ignorePatterns = toIgnoreGlobs(
    [...EXCLUDED_DIRS].filter((dir) => dir !== 'build'),
  );

  for await (const dir of globIterate('**/build', {
    cwd: workspacePath,
    ignore: ignorePatterns,
    nodir: false,
  })) {
    try {
      await WorkspaceFS.delete(dir, { recursive: true, useTrash: false });
      logger.debug(CHANNEL, `Removed build directory: ${dir}`);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error removing build directory ${dir}: ${toErrorMessage(err)}`,
      );
    }
  }

  logger.info(CHANNEL, 'Build directories cleaned');
}

export async function runCleanOutput(): Promise<void> {
  logger.debug(CHANNEL, 'Starting output directory cleanup');

  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return;
  }

  const modelsPattern = MODELS.join(',');
  const ignorePatterns = toIgnoreGlobs(unique([...EXCLUDED_DIRS, HISTORY_DIR]));

  // Workspace-wide cleanup only uses legacy generated filename tokens.
  // Round-folder layouts like `r0/output.tex` are intentionally excluded:
  // without an active run context they are indistinguishable from user-owned
  // revision folders. Toolbar cleanup removes task-run storage directly.
  for await (const file of globIterate(
    `**/*_{${modelsPattern}}*.{tex,pdf,xml}`,
    {
      cwd: workspacePath,
      ignore: ignorePatterns,
      nodir: true,
    },
  )) {
    await WorkspaceFS.delete(file);
  }

  logger.info(CHANNEL, 'All AI Generated Output files cleaned');
}
