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

export interface MultipleOperationOptions extends OperationOptions {
  inputFiles: string[];
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
    const movedFiles = new Set<string>();
    const copiedFiles = new Set<string>();

    const searchTasks = filePatterns.flatMap((pattern) =>
      PACK_EXTENSIONS.map(async (ext) => {
        const filePath = await WorkspaceFS.findFileInBuild(
          inputDir,
          pattern,
          ext,
        );
        return { filePath, pattern };
      }),
    );

    const searchResults = await Promise.all(searchTasks);

    for (const { filePath, pattern } of searchResults) {
      if (filePath) {
        if (filePath === inputFile || pattern === baseName) {
          copiedFiles.add(filePath);
        } else {
          movedFiles.add(filePath);
        }
      }
    }

    const onlyInputFilePacked =
      movedFiles.size === 0 &&
      copiedFiles.size === 1 &&
      copiedFiles.has(inputFile);

    if (onlyInputFilePacked) {
      logger.warn(CHANNEL, `No files found to pack for ${inputFile}`);
      return { status: 'noFiles' };
    }

    if (movedFiles.size === 0 && copiedFiles.size === 0) {
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
      const moveTasks = Array.from(movedFiles).map(async (file) => {
        const dest = path.join(outputFolder, path.basename(file));
        operations.push(`Moving: ${file} -> ${dest}`);
        await WorkspaceFS.move(file, dest);
      });
      const copyTasks = Array.from(copiedFiles).map(async (file) => {
        const dest = path.join(outputFolder, path.basename(file));
        operations.push(`Copying: ${file} -> ${dest}`);
        await WorkspaceFS.copy(file, dest);
      });
      await Promise.all([...moveTasks, ...copyTasks]);
      if (operations.length > 0 && !onlyInputFilePacked) {
        logger.info(CHANNEL, `Files packed into ${outputFolder}`);
        logger.debug(CHANNEL, `File operations:\n${operations.join('\n')}`);
      }
      // Clean up temporary files
      const tempSearchTasks = filePatterns.flatMap((pattern) =>
        TEMP_EXTENSIONS.map((ext) =>
          WorkspaceFS.findFileInBuild(inputDir, pattern, ext),
        ),
      );
      const tempFiles = await Promise.all(tempSearchTasks);
      const deleteTasks = tempFiles
        .filter((t): t is string => !!t && t !== inputFile)
        .map((file) => WorkspaceFS.delete(file));
      await Promise.all(deleteTasks);
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
  const deleteSearchTasks = filePatterns.flatMap((pattern) =>
    extensions.map((ext) =>
      WorkspaceFS.findFileInBuild(inputDir, pattern, ext),
    ),
  );
  const searchResults = await Promise.all(deleteSearchTasks);
  const filesToDelete = searchResults.filter((res): res is string => !!res);

  const onlyInputFileFound =
    filesToDelete.length === 1 && filesToDelete[0] === inputFile;

  if (onlyInputFileFound || filesToDelete.length === 0) {
    logger.warn(CHANNEL, `No matching files found to clean for ${inputFile}`);
    return { status: 'noFiles' };
  }

  try {
    logger.debug(CHANNEL, `Files to delete:\n${filesToDelete.join('\n')}`);
    const deleteTasks = filesToDelete.map((filePath) =>
      WorkspaceFS.delete(filePath),
    );
    await Promise.all(deleteTasks);
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

export async function runOperationMultiple(
  options: MultipleOperationOptions,
): Promise<FileOpResult> {
  const { inputFile, inputFiles, operation, model, agent } = options;
  logger.debug(
    CHANNEL,
    `Starting multiple ${operation} with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  const allFiles = Array.from(new Set([inputFile, ...inputFiles]));

  if (operation === 'pack') {
    const baseName = path.parse(inputFile).name;
    const outputDir = path.dirname(inputFile);
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    const outputFolder =
      options.outputFolder ||
      path.join(
        outputDir,
        HISTORY_DIR,
        `${now}_${baseName}_multiple_${agent}_${model}`,
      );

    const results = await Promise.all(
      allFiles.map((file) =>
        runOperationSingle({
          operation,
          model,
          inputFile: file,
          agent,
          outputFolder,
        }),
      ),
    );

    const anySuccess = results.some((r) => r.status === 'success');

    const agentChunk = getAgentFirstNameChunk(agent);
    const extraPatterns = [
      `${baseName}_${agentChunk}_r0_${model}.xml`,
      `${baseName}_${agentChunk}_r1_${model}.xml`,
    ];

    const extraTasks = extraPatterns.map(async (pattern) => {
      const filePath = path.join(outputDir, pattern);
      if (await WorkspaceFS.exists(filePath)) {
        if (!anySuccess) {
          await WorkspaceFS.createDir(outputFolder);
        }
        await WorkspaceFS.move(filePath, path.join(outputFolder, pattern));
        return true;
      }
      return false;
    });

    const extraMoved = (await Promise.all(extraTasks)).some(Boolean);

    if (anySuccess || extraMoved) {
      logger.info(CHANNEL, `All files packed into ${outputFolder}`);
      return { status: 'success', outputFolder };
    }

    return { status: 'noFiles' };
  }

  const results = await Promise.all(
    allFiles.map((file) =>
      runOperationSingle({ operation, model, inputFile: file, agent }),
    ),
  );

  const errorResult = results.find((r) => r.status === 'error');
  if (errorResult) {
    return errorResult;
  }
  const missing = results.find((r) => r.status === 'missingParams');
  if (missing) {
    return missing;
  }

  const anySuccess = results.some((r) => r.status === 'success');
  return anySuccess ? { status: 'success' } : { status: 'noFiles' };
}
