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
import { runOperationSingle, runOperationMultiple } from './fileOps';

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
  return runOperationMultiple({
    operation: 'pack',
    model,
    inputFile,
    agent,
    inputFiles,
  });
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
