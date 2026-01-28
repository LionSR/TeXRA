// Standard library imports
import * as path from 'path';

// Local imports - result types
import type { FileOpResult } from '@agent/types/ResultTypes';

// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';

// Local file imports
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

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

function generateTimestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, '').split('.')[0];
}

export async function runPackSingle(
  model: string,
  inputFile: string,
  agent: string,
  outputFolder?: string,
): Promise<FileOpResult> {
  logger.info(
    CHANNEL,
    `Starting packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputFolder=${outputFolder}`,
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

  if (movedFiles.length === 0 && copiedFiles.length === 0) {
    logger.warn(CHANNEL, `No files found to pack for ${inputFile}`);
    return { status: 'noFiles' };
  }

  logger.debug(CHANNEL, buildFileListLog(movedFiles, copiedFiles));

  const resolvedOutputFolder =
    outputFolder ||
    path.join(
      inputDir,
      HISTORY_DIR,
      `${generateTimestamp()}_${baseName}_${agent}_${model}`,
    );
  logger.debug(CHANNEL, `Output folder: ${resolvedOutputFolder}`);

  try {
    await WorkspaceFS.createDir(resolvedOutputFolder);
    logger.debug(CHANNEL, `Created output directory: ${resolvedOutputFolder}`);

    const operations = await moveAndCopyFiles(
      movedFiles,
      copiedFiles,
      resolvedOutputFolder,
    );

    if (operations.length > 0) {
      logger.info(CHANNEL, `Files packed into ${resolvedOutputFolder}`);
      logger.debug(CHANNEL, `File operations:\n${operations.join('\n')}`);
    }

    await cleanupTempFiles(inputDir, filePatterns, movedFiles, copiedFiles);

    return { status: 'success', outputFolder: resolvedOutputFolder };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error during file operations: ${toErrorMessage(err)}`,
    );
    return { status: 'error', error: toErrorMessage(err) };
  }
}

export async function runPackMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
): Promise<FileOpResult> {
  logger.debug(
    CHANNEL,
    `Starting multiple packing with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  const baseName = path.parse(inputFile).name;
  const outputDir = path.dirname(inputFile);
  const commonOutputFolder = path.join(
    outputDir,
    HISTORY_DIR,
    `${generateTimestamp()}_${baseName}_multiple_${agent}_${model}`,
  );
  logger.debug(CHANNEL, `Common output folder: ${commonOutputFolder}`);

  try {
    const allFilesToPack = [inputFile, ...inputFiles];
    const results = await Promise.all(
      allFilesToPack.map((file) =>
        runPackSingle(model, file, agent, commonOutputFolder),
      ),
    );
    const anyFilesPacked = results.some((r) => r.status === 'success');

    const xmlFilesPacked = await packAdditionalXmlFiles(
      outputDir,
      baseName,
      agent,
      model,
      commonOutputFolder,
      anyFilesPacked,
    );

    if (anyFilesPacked || xmlFilesPacked) {
      logger.info(CHANNEL, `All files packed into ${commonOutputFolder}`);
      return { status: 'success', outputFolder: commonOutputFolder };
    }

    logger.warn(CHANNEL, `No files found to pack for ${inputFile}`);
    return { status: 'noFiles' };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error during multiple pack operation: ${toErrorMessage(err)}`,
    );
    return { status: 'error', error: toErrorMessage(err) };
  }
}

export async function runPack(
  model: string,
  inputFile: string,
  agent: string,
  outputFiles: string[] = [],
): Promise<FileOpResult> {
  if (outputFiles.length > 0) {
    return runPackMultiple(model, inputFile, agent, outputFiles);
  }
  return runPackSingle(model, inputFile, agent);
}

function buildFileListLog(movedFiles: string[], copiedFiles: string[]): string {
  const parts = ['Found files to process:'];
  if (movedFiles.length > 0) {
    parts.push(`Files to move:\n${movedFiles.join('\n')}`);
  }
  if (copiedFiles.length > 0) {
    parts.push(`Files to copy:\n${copiedFiles.join('\n')}`);
  }
  return parts.join('\n');
}

async function moveAndCopyFiles(
  movedFiles: string[],
  copiedFiles: string[],
  outputFolder: string,
): Promise<string[]> {
  const operations: string[] = [];

  for (const file of movedFiles) {
    const destination = path.join(outputFolder, path.basename(file));
    operations.push(`Moving: ${file} -> ${destination}`);
    await WorkspaceFS.rename(file, destination);
  }

  for (const file of copiedFiles) {
    const destination = path.join(outputFolder, path.basename(file));
    operations.push(`Copying: ${file} -> ${destination}`);
    await WorkspaceFS.copy(file, destination);
  }

  return operations;
}

async function cleanupTempFiles(
  inputDir: string,
  filePatterns: string[],
  movedFiles: string[],
  copiedFiles: string[],
): Promise<void> {
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
}

async function packAdditionalXmlFiles(
  outputDir: string,
  baseName: string,
  agent: string,
  model: string,
  commonOutputFolder: string,
  outputFolderExists: boolean,
): Promise<boolean> {
  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const maxRounds = getConfig<number>('texra.agent.rounds', DEFAULT_MAX_ROUNDS);

  let anyPacked = false;
  for (let i = 0; i < maxRounds; i++) {
    const pattern = `${baseName}_${agentFirstNameChunk}_r${i}_${model}.xml`;
    const filePath = path.join(outputDir, pattern);

    if (await WorkspaceFS.exists(filePath)) {
      if (!outputFolderExists && !anyPacked) {
        await WorkspaceFS.createDir(commonOutputFolder);
      }
      logger.debug(CHANNEL, `Found additional XML file: ${filePath}`);
      await WorkspaceFS.rename(
        filePath,
        path.join(commonOutputFolder, pattern),
      );
      anyPacked = true;
    }
  }

  return anyPacked;
}
