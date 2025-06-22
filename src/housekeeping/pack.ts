// Local imports - result types
import type { FileOpResult } from '@/types/ResultTypes';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - housekeeping
import {
  runOperationSingle,
  runOperationMultiple,
  runOperation,
} from './fileOps';

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

  return runOperation({
    operation: 'pack',
    model,
    inputFile,
    agent,
    inputFiles: outputFiles,
  });
}
