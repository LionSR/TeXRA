// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - result types
import type { FileOpResult } from '@agent/types/ResultTypes';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { AbsoluteFS, StorageFS, WorkspaceFS } from '@utils/files';
import { isValidExecutionId, TASK_RUNS_DIR } from '@utils/files/taskRunStorage';
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - housekeeping
import {
  PACK_EXTENSIONS,
  TEMP_EXTENSIONS,
  HISTORY_DIR,
  DEFAULT_MAX_ROUNDS,
} from './constants';
import {
  getAgentFirstNameChunk,
  getFilePatterns,
  findFilesFromPatterns,
} from './utils';
import { getConfig } from '@utils/config';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

interface PackOptions {
  outputFolder?: string;
  executionId?: ExecutionId;
}

async function resolveOutputFolder(
  inputDir: string,
  baseName: string,
  agent: string,
  model: string,
  options?: PackOptions,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];

  if (options?.outputFolder) {
    return options.outputFolder;
  }

  if (options?.executionId && isValidExecutionId(options.executionId)) {
    const relativeBase = path.join(
      TASK_RUNS_DIR,
      options.executionId,
      'packed',
    );
    await StorageFS.ensureDir(relativeBase);
    const relativeFolder = path.join(
      relativeBase,
      `${timestamp}_${baseName}_${agent}_${model}`,
    );
    return StorageFS.fullPath(relativeFolder);
  }

  const workspaceFolder = path.join(
    inputDir,
    HISTORY_DIR,
    `${timestamp}_${baseName}_${agent}_${model}`,
  );
  return workspaceFolder;
}

async function ensureDirectory(folder: string): Promise<void> {
  if (path.isAbsolute(folder)) {
    await AbsoluteFS.ensureDir(folder);
  } else {
    await WorkspaceFS.ensureDir(folder);
  }
}

function getDestinationPath(folder: string, file: string): string {
  return path.join(folder, path.basename(file));
}

async function moveFile(
  sourceRelative: string,
  destinationFolder: string,
): Promise<void> {
  const destination = getDestinationPath(destinationFolder, sourceRelative);
  if (path.isAbsolute(destinationFolder)) {
    const sourceAbsolute = WorkspaceFS.fullPath(sourceRelative);
    await AbsoluteFS.rename(sourceAbsolute, destination, { overwrite: true });
  } else {
    await WorkspaceFS.rename(sourceRelative, destination);
  }
}

async function copyFile(
  sourceRelative: string,
  destinationFolder: string,
): Promise<void> {
  const destination = getDestinationPath(destinationFolder, sourceRelative);
  if (path.isAbsolute(destinationFolder)) {
    const sourceAbsolute = WorkspaceFS.fullPath(sourceRelative);
    await AbsoluteFS.copy(sourceAbsolute, destination, { overwrite: true });
  } else {
    await WorkspaceFS.copy(sourceRelative, destination);
  }
}

export async function runPackSingle(
  model: string,
  inputFile: string,
  agent: string,
  options?: PackOptions,
): Promise<FileOpResult> {
  logger.info(
    CHANNEL,
    `Starting packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputFolder=${options?.outputFolder ?? 'auto'}`,
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
  const maxRounds = getConfig<number>('agent.rounds', DEFAULT_MAX_ROUNDS);
  const filePatterns = [
    ...getFilePatterns(baseName, model, agentFirstNameChunk, maxRounds),
    baseName,
  ];
  logger.debug(CHANNEL, `Generated patterns: ${filePatterns}`);

  const allFiles = findFilesFromPatterns(
    inputDir,
    filePatterns,
    PACK_EXTENSIONS,
  );
  const movedFiles: string[] = [];
  const copiedFiles: string[] = [];

  for (const file of allFiles) {
    if (file === inputFile || path.parse(file).name === baseName) {
      copiedFiles.push(file);
    } else {
      movedFiles.push(file);
    }
  }

  const onlyInputFilePacked =
    movedFiles.length === 0 &&
    copiedFiles.length === 1 &&
    copiedFiles[0] === inputFile;

  if (onlyInputFilePacked) {
    logger.warn(CHANNEL, `No files found to pack for ${inputFile}`);
    return { status: 'noFiles' };
  }

  let result: FileOpResult;
  if (movedFiles.length > 0 || copiedFiles.length > 0) {
    logger.debug(
      CHANNEL,
      'Found files to process:' +
        (movedFiles.length > 0
          ? `\nFiles to move:\n${movedFiles.join('\n')}`
          : '') +
        (copiedFiles.length > 0
          ? `\nFiles to copy:\n${copiedFiles.join('\n')}`
          : ''),
    );

    try {
      const destinationFolder = await resolveOutputFolder(
        inputDir,
        baseName,
        agent,
        model,
        options,
      );
      logger.debug(CHANNEL, `Output folder: ${destinationFolder}`);
      await ensureDirectory(destinationFolder);
      logger.debug(
        CHANNEL,
        `Created output directory: ${destinationFolder}`,
      );

      const operations: string[] = [];
      for (const file of movedFiles) {
        const destination = getDestinationPath(destinationFolder, file);
        operations.push(`Moving: ${file} -> ${destination}`);
        await moveFile(file, destinationFolder);
      }
      for (const file of copiedFiles) {
        const destination = getDestinationPath(destinationFolder, file);
        operations.push(`Copying: ${file} -> ${destination}`);
        await copyFile(file, destinationFolder);
      }
      if (operations.length > 0 && !onlyInputFilePacked) {
        logger.info(CHANNEL, `Files packed into ${destinationFolder}`);
        logger.debug(CHANNEL, `File operations:\n${operations.join('\n')}`);
      }
      result = { status: 'success', outputFolder: destinationFolder };
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error during file operations: ${err instanceof Error ? err.message : String(err)}`,
      );
      result = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    logger.warn(CHANNEL, `No files found to pack for ${inputFile}`);
    result = { status: 'noFiles' };
  }

  const tempFiles = findFilesFromPatterns(
    inputDir,
    filePatterns,
    TEMP_EXTENSIONS,
  );
  const skip = new Set([...movedFiles, ...copiedFiles]);
  for (const file of tempFiles) {
    if (!skip.has(file)) {
      await WorkspaceFS.delete(file);
    }
  }

  return result;
}

export async function runPackMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
  options?: PackOptions,
): Promise<FileOpResult> {
  logger.debug(
    CHANNEL,
    `Starting multiple packing with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  const fileToPack = inputFile;
  const baseName = path.parse(fileToPack).name;
  const outputDir = path.dirname(fileToPack);

  const commonOutputFolder = await resolveOutputFolder(
    outputDir,
    baseName,
    `${agent}_multiple`,
    model,
    options,
  );
  logger.debug(CHANNEL, `Common output folder: ${commonOutputFolder}`);

  try {
    let anyFilesPacked = false;

    // Pack the main input file
    const singleResult = await runPackSingle(
      model,
      fileToPack,
      agent,
      { ...options, outputFolder: commonOutputFolder },
    );
    if (singleResult.status === 'success') {
      anyFilesPacked = true;
    }
    // Pack additional files
    if (inputFiles && inputFiles.length > 0) {
      for (const file of inputFiles) {
        // logger.debug(CHANNEL, `Packing input file: ${file}`);
        const additionalResult = await runPackSingle(
          model,
          file,
          agent,
          { ...options, outputFolder: commonOutputFolder },
        );
        if (additionalResult.status === 'success') {
          anyFilesPacked = true;
        }
      }
    }

    // Pack additional XML files
    const agentFirstNameChunk = getAgentFirstNameChunk(agent);
    const maxRounds = getConfig<number>('agent.rounds', DEFAULT_MAX_ROUNDS);
    const additionalPatterns: string[] = [];
    for (let i = 0; i < maxRounds; i++) {
      additionalPatterns.push(
        `${baseName}_${agentFirstNameChunk}_r${i}_${model}.xml`,
      );
    }

    for (const pattern of additionalPatterns) {
      const filePath = path.join(outputDir, pattern);
      if (await WorkspaceFS.exists(filePath)) {
        if (!anyFilesPacked) {
          await ensureDirectory(commonOutputFolder);
        }
        logger.debug(CHANNEL, `Found additional XML file: ${filePath}`);
        await moveFile(filePath, commonOutputFolder);
        anyFilesPacked = true;
      }
    }

    if (anyFilesPacked) {
      logger.info(CHANNEL, `All files packed into ${commonOutputFolder}`);
      return { status: 'success', outputFolder: commonOutputFolder };
    }

    logger.warn(CHANNEL, `No files found to pack for ${inputFile}`);
    return { status: 'noFiles' };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error during multiple pack operation: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runPack(
  model: string,
  inputFile: string,
  agent: string,
  outputFiles: string[] = [],
  options?: PackOptions,
): Promise<FileOpResult> {
  logger.debug(
    CHANNEL,
    `Starting pack with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  logger.debug(CHANNEL, `Additional files: ${outputFiles.join(', ')}`);

  if (!inputFile || !model || !agent) {
    logger.error(
      CHANNEL,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    return { status: 'missingParams' };
  }

  // Use multiple mode if there are output files
  if (outputFiles.length > 0) {
    return await runPackMultiple(
      model,
      inputFile,
      agent,
      outputFiles,
      options,
    );
  } else {
    return await runPackSingle(model, inputFile, agent, options);
  }
}
