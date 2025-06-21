// Standard library imports
import * as path from 'path';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - result types
import type { FileOpResult } from '@/types/ResultTypes';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

// Local imports - housekeeping
import { HISTORY_DIR, PACK_EXTENSIONS, TEMP_EXTENSIONS } from './constants';
import { getAgentFirstNameChunk, getFilePatterns } from './utils';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

export type OperationType = 'pack' | 'clean';

export interface OperationOptions {
  operation: OperationType;
  model: string;
  inputFile: string;
  agent: string;
  outputFolder?: string;
}

export async function runOperationSingle(
  options: OperationOptions,
): Promise<FileOpResult> {
  const { operation, model, inputFile, agent } = options;
  logger.info(
    CHANNEL,
    `Starting ${operation} with model=${model}, inputFile=${inputFile}, agent=${agent}`,
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

  const agentChunk = getAgentFirstNameChunk(agent);
  const filePatterns = [
    ...getFilePatterns(baseName, model, agentChunk),
    ...(operation === 'pack' ? [baseName] : []),
  ];
  logger.debug(CHANNEL, `Generated patterns: ${filePatterns}`);

  if (operation === 'pack') {
    const movedFiles: string[] = [];
    const copiedFiles: string[] = [];

    for (const pattern of filePatterns) {
      for (const ext of PACK_EXTENSIONS) {
        const filePath = await WorkspaceFS.findFileInBuild(
          inputDir,
          pattern,
          ext,
        );
        if (filePath) {
          if (filePath === inputFile || pattern === baseName) {
            copiedFiles.push(filePath);
          } else {
            movedFiles.push(filePath);
          }
        }
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

    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    const outputFolder =
      options.outputFolder ||
      path.join(inputDir, HISTORY_DIR, `${now}_${baseName}_${agent}_${model}`);
    logger.debug(CHANNEL, `Output folder: ${outputFolder}`);

    try {
      await WorkspaceFS.createDir(outputFolder);
      const operations: string[] = [];
      for (const file of movedFiles) {
        const dest = path.join(outputFolder, path.basename(file));
        operations.push(`Moving: ${file} -> ${dest}`);
        await WorkspaceFS.move(file, dest);
      }
      for (const file of copiedFiles) {
        const dest = path.join(outputFolder, path.basename(file));
        operations.push(`Copying: ${file} -> ${dest}`);
        await WorkspaceFS.copy(file, dest);
      }
      if (operations.length > 0 && !onlyInputFilePacked) {
        logger.info(CHANNEL, `Files packed into ${outputFolder}`);
        logger.debug(CHANNEL, `File operations:\n${operations.join('\n')}`);
      }
      // Clean up temporary files
      for (const pattern of filePatterns) {
        for (const ext of TEMP_EXTENSIONS) {
          const temp = await WorkspaceFS.findFileInBuild(
            inputDir,
            pattern,
            ext,
          );
          if (temp && temp !== inputFile) {
            await WorkspaceFS.delete(temp);
          }
        }
      }
      return { status: 'success', outputFolder };
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error during file operations: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // clean operation
  const extensions = [...TEMP_EXTENSIONS, ...PACK_EXTENSIONS];
  const filesToDelete: string[] = [];
  for (const pattern of filePatterns) {
    for (const ext of extensions) {
      const filePath = await WorkspaceFS.findFileInBuild(
        inputDir,
        pattern,
        ext,
      );
      if (filePath) {
        filesToDelete.push(filePath);
      }
    }
  }

  const onlyInputFileFound =
    filesToDelete.length === 1 && filesToDelete[0] === inputFile;

  if (onlyInputFileFound || filesToDelete.length === 0) {
    logger.warn(CHANNEL, `No matching files found to clean for ${inputFile}`);
    return { status: 'noFiles' };
  }

  try {
    logger.debug(CHANNEL, `Files to delete:\n${filesToDelete.join('\n')}`);
    for (const filePath of filesToDelete) {
      await WorkspaceFS.delete(filePath);
    }
    logger.info(CHANNEL, `Cleanup complete for ${inputFile}`);
    return { status: 'success' };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error during cleanup of ${inputFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
