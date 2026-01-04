// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { sync as globSync } from 'glob';

// Local imports - log
import type { FileOpResult } from '@agent/types/ResultTypes';

// Internal imports
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { MODELS } from '@model/ModelRegistry';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';

// Local file imports
import {
  EXCLUDED_DIRS,
  TEMP_EXTENSIONS,
  PACK_EXTENSIONS,
  DEFAULT_MAX_ROUNDS,
} from './constants';
import {
  getAgentFirstNameChunk,
  getFilePatterns,
  findFilesFromPatterns,
} from './utils';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

export async function runCleanSingle(
  model: string,
  inputFile: string,
  agent: string,
): Promise<FileOpResult> {
  logger.info(
    CHANNEL,
    `Starting cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );

  if (!inputFile || !model || !agent) {
    logger.error(
      CHANNEL,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    return { status: 'missingParams' };
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  logger.debug(
    CHANNEL,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const maxRounds = getConfig<number>('texra.agent.rounds', DEFAULT_MAX_ROUNDS);
  const filePatterns = getFilePatterns(
    baseName,
    model,
    agentFirstNameChunk,
    maxRounds,
  );
  logger.debug(CHANNEL, `Generated patterns: ${filePatterns}`);

  const extensions = [...TEMP_EXTENSIONS, ...PACK_EXTENSIONS];
  logger.debug(CHANNEL, `Using extensions: ${extensions}`);

  const filesToDelete = findFilesFromPatterns(
    inputDir,
    filePatterns,
    extensions,
  );

  const onlyInputFileFound =
    filesToDelete.length === 1 && filesToDelete[0] === inputFile;

  let result: FileOpResult;

  if (onlyInputFileFound || filesToDelete.length === 0) {
    logger.warn(CHANNEL, `No matching files found to clean for ${inputFile}`);
    result = { status: 'noFiles' };
  } else {
    try {
      logger.debug(CHANNEL, `Files to delete:\n${filesToDelete.join('\n')}`);
      for (const filePath of filesToDelete) {
        await WorkspaceFS.delete(filePath);
      }
      logger.info(CHANNEL, `Cleanup complete for ${inputFile}`);
      result = { status: 'success' };
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error during cleanup of ${inputFile}: ${toErrorMessage(err)}`,
      );
      result = {
        status: 'error',
        error: toErrorMessage(err),
      };
    }
  }

  return result;
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

  let anyCleaned = false;

  const firstResult = await runCleanSingle(model, inputFile, agent);
  if (
    firstResult.status === 'missingParams' ||
    firstResult.status === 'error'
  ) {
    return firstResult;
  }
  if (firstResult.status === 'success') {
    anyCleaned = true;
  }

  if (inputFiles && inputFiles.length > 0) {
    for (const file of inputFiles) {
      const res = await runCleanSingle(model, file, agent);
      if (res.status === 'error') {
        return res;
      }
      if (res.status === 'success') {
        anyCleaned = true;
      }
    }
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

  const ignorePatterns = [...EXCLUDED_DIRS]
    .filter((dir) => dir !== 'build')
    .map((dir) => `**/${dir}/**`);

  const buildDirs = globSync('**/build', {
    cwd: workspacePath,
    ignore: ignorePatterns,
    nodir: false,
  });

  for (const dir of buildDirs) {
    try {
      await vscode.workspace.fs.delete(
        vscode.Uri.file(path.join(workspacePath, dir)),
        {
          recursive: true,
          useTrash: false,
        },
      );
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
  const ignorePatterns = [...EXCLUDED_DIRS].map((d) => `**/${d}/**`);

  const files = globSync(`**/*_{${modelsPattern}}*.{tex,pdf,xml}`, {
    cwd: workspacePath,
    ignore: ignorePatterns,
    nodir: true,
  });

  for (const file of files) {
    await WorkspaceFS.delete(file);
  }

  logger.info(CHANNEL, 'All AI Generated Output files cleaned');
}
