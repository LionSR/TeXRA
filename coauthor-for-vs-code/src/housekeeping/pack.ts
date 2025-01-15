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
logger.initialize(CHANNEL);

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
      'Missing required parameters for packSingle',
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
        if (filePath === inputFile || pattern === baseName) {
          copiedFiles.push(filePath);
        } else {
          movedFiles.push(filePath);
        }
      }
    }
  }

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
      await createDirectory(outputFolder);
      logger.debug(CHANNEL, `Created output directory: ${outputFolder}`);

      // Move and copy files
      const operations: string[] = [];
      for (const file of movedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        operations.push(`Moving: ${file} -> ${destination}`);
        await moveFile(file, destination);
      }
      for (const file of copiedFiles) {
        const destination = path.join(outputFolder, path.basename(file));
        operations.push(`Copying: ${file} -> ${destination}`);
        await copyFile(file, destination);
      }
      // if only inputFile is packed, don't show message
      // potential improvement here
      if (operations.length > 1) {
        logger.info(CHANNEL, `Files packed into ${outputFolder}`);
        vscode.window.showInformationMessage(
          `Files packed into ${outputFolder}`,
        );
        logger.debug(CHANNEL, `File operations:\n${operations.join('\n')}`);
      }
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

  const fileToPack = outputNameOverride || inputFile;
  baseName = path.parse(fileToPack).name;
  outputDir = path.dirname(fileToPack);

  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const commonOutputFolder = path.join(
    outputDir,
    HISTORY_DIR,
    `${now}_${baseName}_multiple_${agent}_${model}`,
  );
  logger.debug(CHANNEL, `Common output folder: ${commonOutputFolder}`);

  try {
    await createDirectory(commonOutputFolder);
    logger.debug(CHANNEL, `Created output directory: ${commonOutputFolder}`);

    // Pack the main input file
    await runPackSingle(model, fileToPack, agent, commonOutputFolder);
    // Pack additional files
    if (inputFiles && inputFiles.length > 0) {
      for (const file of inputFiles) {
        // logger.debug(CHANNEL, `Packing input file: ${file}`);
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

export async function runPack(
  model: string,
  inputFile: string,
  agent: string,
  outputFiles: string[] = [],
  outputNameOverride?: string,
): Promise<string> {
  logger.debug(
    CHANNEL,
    `Starting pack with model=${model}, inputFile=${inputFile}, agent=${agent}, outputNameOverride=${outputNameOverride}`,
  );
  logger.debug(CHANNEL, `Additional files: ${outputFiles.join(', ')}`);

  if (!inputFile || !model || !agent) {
    logger.error(
      CHANNEL,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    vscode.window.showErrorMessage('Missing required parameters for pack');
    return '';
  }

  const fileToPack = outputNameOverride || inputFile;

  // Use multiple mode if there are output files
  if (outputFiles.length > 0) {
    return runPackMultiple(
      model,
      inputFile,
      agent,
      outputFiles,
      outputNameOverride,
    );
  } else {
    return runPackSingle(model, inputFile, agent, outputNameOverride);
  }
}
