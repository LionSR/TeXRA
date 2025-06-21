// Standard library imports
import * as path from 'path';

// Third-party imports

// Local imports - result types
import type { FileOpResult } from '@/types/ResultTypes';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

// Local imports - housekeeping
import { HISTORY_DIR } from './constants';
import { getAgentFirstNameChunk } from './utils';
import { runOperationSingle } from './fileOps';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);
export async function runPackSingle(
  model: string,
  inputFile: string,
  agent: string,
  outputFolder?: string,
): Promise<FileOpResult> {
  return runOperationSingle({
    operation: 'pack',
    model,
    inputFile,
    agent,
    outputFolder,
  });
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
    const additionalPatterns = [
      `${baseName}_${agentFirstNameChunk}_r0_${model}.xml`,
      `${baseName}_${agentFirstNameChunk}_r1_${model}.xml`,
    ];

    for (const pattern of additionalPatterns) {
      const filePath = path.join(outputDir, pattern);
      if (await WorkspaceFS.exists(filePath)) {
        if (!anyFilesPacked) {
          await WorkspaceFS.createDir(commonOutputFolder);
        }
        logger.debug(CHANNEL, `Found additional XML file: ${filePath}`);
        await WorkspaceFS.move(
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
