// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import {
  deleteFile,
  moveFile,
  copyFile,
  findFileInBuild,
  createDirectory,
  fileExists,
} from '../utils/fileUtils';

// Local imports - housekeeping
import { PACK_EXTENSIONS, TEMP_EXTENSIONS, HISTORY_DIR } from './constants';
import { getAgentFirstNameChunk, getFilePatterns } from './utils';

const CHANNEL = 'Housekeeping';
logger.initializeLogging(CHANNEL);
export async function runPackSingle(
  model: string,
  inputFile: string,
  agent: string,
  outputFolder?: string,
): Promise<string> {
  logger.info(
    CHANNEL,
    `Starting packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputFolder=${outputFolder}`,
  );

  if (!inputFile || !model || !agent) {
    logger.error(
      CHANNEL,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for pack single',
    );
    return '';
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  logger.debug(
    CHANNEL,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const filePatterns = [
    ...getFilePatterns(baseName, model, agentFirstNameChunk),
    baseName,
  ];
  logger.debug(CHANNEL, `Generated patterns: ${filePatterns}`);

  const movedFiles: string[] = [];
  const copiedFiles: string[] = [];

  // Find files to move or copy
  for (const pattern of filePatterns) {
    for (const ext of PACK_EXTENSIONS) {
      const filePath = await findFileInBuild(inputDir, pattern, ext);
      if (filePath) {
        logger.debug(CHANNEL, `Found file: ${filePath}`);
        if (filePath === inputFile || pattern === baseName) {
          copiedFiles.push(filePath);
        } else {
          movedFiles.push(filePath);
        }
      }
    }
  }

  logger.debug(CHANNEL, `Files to move: ${movedFiles}`);
  logger.debug(CHANNEL, `Files to copy: ${copiedFiles}`);

  if (movedFiles.length > 0 || copiedFiles.length > 0) {
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    outputFolder =
      outputFolder ||
      path.join(inputDir, HISTORY_DIR, `${now}_${baseName}_${agent}_${model}`);
    logger.debug(CHANNEL, `Output folder: ${outputFolder}`);

    try {
      // Use the new helper function
      await createDirectory(outputFolder);
      logger.debug(CHANNEL, `Created output directory: ${outputFolder}`);

      // Move and copy files
      for (const file of movedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        logger.debug(CHANNEL, `Moving file from ${file} to ${destination}`);
        await moveFile(file, destination);
      }
      for (const file of copiedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        logger.debug(CHANNEL, `Copying file from ${file} to ${destination}`);
        await copyFile(file, destination);
      }

      logger.info(CHANNEL, `Files packed into ${outputFolder}`);
      vscode.window.showInformationMessage(`Files packed into ${outputFolder}`);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error during file operations: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage(`Error during packing: ${err}`);
      return '';
    }
  } else {
    logger.warn(CHANNEL, `No files found to pack for ${inputFile}`);
    vscode.window.showInformationMessage(
      `No files found to pack for ${inputFile}`,
    );
  }

  // Clean up temporary files
  for (const pattern of filePatterns) {
    for (const ext of TEMP_EXTENSIONS) {
      const filePath = await findFileInBuild(inputDir, pattern, ext);
      if (filePath && filePath !== inputFile) {
        await deleteFile(filePath);
      }
    }
  }

  return outputFolder || '';
}

export async function runPackMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
  outputNameOverride?: string,
): Promise<string> {
  logger.debug(
    CHANNEL,
    `Starting multiple packing with model=${model}, inputFile=${inputFile}, agent=${agent}, outputNameOverride=${outputNameOverride}`,
  );
  logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  let baseName: string;
  let outputDir: string;

  if (outputNameOverride) {
    baseName = path.parse(outputNameOverride).name;
    outputDir = path.dirname(outputNameOverride);
  } else {
    baseName = path.parse(inputFile).name;
    outputDir = path.dirname(inputFile);
  }

  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const commonOutputFolder =
    outputNameOverride ||
    path.join(
      outputDir,
      HISTORY_DIR,
      `${now}_${baseName}_multiple_${agent}_${model}`,
    );
  logger.debug(CHANNEL, `Common output folder: ${commonOutputFolder}`);

  try {
    await createDirectory(commonOutputFolder);
    logger.debug(CHANNEL, `Created output directory: ${commonOutputFolder}`);

    // Pack the main input file
    await runPackSingle(model, inputFile, agent, commonOutputFolder);

    // Pack additional files
    if (inputFiles && inputFiles.length > 0) {
      for (const file of inputFiles) {
        logger.debug(CHANNEL, `Packing input file: ${file}`);
        await runPackSingle(model, file, agent, commonOutputFolder);
      }
    }

    // Pack additional XML files
    const agentFirstNameChunk = getAgentFirstNameChunk(agent);
    const additionalPatterns = [
      `${baseName}_${agentFirstNameChunk}_r0_${model}.xml`,
      `${baseName}_${agentFirstNameChunk}_r1_${model}.xml`,
    ];

    for (const pattern of additionalPatterns) {
      const filePath = path.join(outputDir, pattern);
      if (await fileExists(filePath)) {
        logger.debug(CHANNEL, `Found additional XML file: ${filePath}`);
        await moveFile(filePath, path.join(commonOutputFolder, pattern));
      }
    }

    logger.info(CHANNEL, `All files packed into ${commonOutputFolder}`);
    return commonOutputFolder;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error during multiple pack operation: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
