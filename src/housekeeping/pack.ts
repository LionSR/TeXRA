// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - result types
import type { FileOpResult } from '@agent/types/ResultTypes';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

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

    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    outputFolder =
      outputFolder ||
      path.join(inputDir, HISTORY_DIR, `${now}_${baseName}_${agent}_${model}`);
    logger.debug(CHANNEL, `Output folder: ${outputFolder}`);

    try {
      await WorkspaceFS.createDir(outputFolder);
      logger.debug(CHANNEL, `Created output directory: ${outputFolder}`);

      // Move and copy files
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
      if (operations.length > 0 && !onlyInputFilePacked) {
        logger.info(CHANNEL, `Files packed into ${outputFolder}`);
        logger.debug(CHANNEL, `File operations:\n${operations.join('\n')}`);
      }
      result = { status: 'success', outputFolder };
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
): Promise<FileOpResult> {
  logger.debug(
    CHANNEL,
    `Starting multiple packing with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  const fileToPack = inputFile;
  const baseName = path.parse(fileToPack).name;
  const outputDir = path.dirname(fileToPack);

  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const commonOutputFolder = path.join(
    outputDir,
    HISTORY_DIR,
    `${now}_${baseName}_multiple_${agent}_${model}`,
  );
  logger.debug(CHANNEL, `Common output folder: ${commonOutputFolder}`);

  try {
    let anyFilesPacked = false;

    // Pack the main input file
    const singleResult = await runPackSingle(
      model,
      fileToPack,
      agent,
      commonOutputFolder,
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
          commonOutputFolder,
        );
        if (additionalResult.status === 'success') {
          anyFilesPacked = true;
        }
      }
    }

    // Pack additional XML files
    const agentFirstNameChunk = getAgentFirstNameChunk(agent);
    const maxRounds = getConfig<number>('texra.agent.rounds', DEFAULT_MAX_ROUNDS);
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
          await WorkspaceFS.createDir(commonOutputFolder);
        }
        logger.debug(CHANNEL, `Found additional XML file: ${filePath}`);
        await WorkspaceFS.rename(
          filePath,
          path.join(commonOutputFolder, pattern),
        );
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
    return await runPackMultiple(model, inputFile, agent, outputFiles);
  } else {
    return await runPackSingle(model, inputFile, agent);
  }
}
