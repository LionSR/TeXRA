// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import {
  deleteFile,
  readDirectory,
  fileExists,
  findFileInBuild,
} from '../utils/fileUtils';

// Local imports - housekeeping
import {
  EXCLUDED_DIRS,
  TEMP_EXTENSIONS,
  PACK_EXTENSIONS,
  MODELS,
} from './constants';
import { getAgentFirstNameChunk, getFilePatterns } from './utils';

const CHANNEL = 'Housekeeping';

export async function runCleanSingle(
  model: string,
  inputFile: string,
  agent: string,
): Promise<void> {
  logger.info(
    CHANNEL,
    `Starting cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );

  if (!inputFile || !model || !agent) {
    logger.error(
      CHANNEL,
      `Missing required parameters: model=${model}, inputFile=${inputFile}, agent=${agent}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for clean single',
    );
    return;
  }

  const baseName = path.parse(inputFile).name;
  const inputDir = path.dirname(inputFile);
  logger.debug(
    CHANNEL,
    `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`,
  );

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const filePatterns = getFilePatterns(baseName, model, agentFirstNameChunk);
  logger.debug(CHANNEL, `Generated patterns: ${filePatterns}`);

  const extensions = [...TEMP_EXTENSIONS, ...PACK_EXTENSIONS];
  logger.debug(CHANNEL, `Using extensions: ${extensions}`);

  let filesFound = false;
  for (const pattern of filePatterns) {
    for (const ext of extensions) {
      const filePath = await findFileInBuild(inputDir, pattern, ext);
      if (filePath) {
        logger.debug(CHANNEL, `Found file to delete: ${filePath}`);
        filesFound = true;
        await deleteFile(filePath);
      }
    }
  }

  if (!filesFound) {
    logger.warn(CHANNEL, `No matching files found to clean for ${inputFile}`);
    vscode.window.showInformationMessage(
      `No files found to clean for ${inputFile}`,
    );
  } else {
    logger.info(CHANNEL, `Cleanup complete for ${inputFile}`);
    vscode.window.showInformationMessage(`Cleanup complete for ${inputFile}`);
  }
}

export async function runCleanMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
): Promise<void> {
  logger.debug(
    CHANNEL,
    `Starting multiple cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  await runCleanSingle(model, inputFile, agent);

  if (inputFiles && inputFiles.length > 0) {
    for (const file of inputFiles) {
      await runCleanSingle(model, file, agent);
    }
  }

  logger.info(CHANNEL, 'Cleanup complete for multiple files.');
}

export async function runCleanBuild(): Promise<void> {
  logger.debug(CHANNEL, 'Starting build directory cleanup');

  async function cleanBuildDir(directory: string) {
    const buildDir = path.join(directory, 'build');
    if (await fileExists(buildDir)) {
      try {
        const entries = await readDirectory(buildDir);
        for (const [name, type] of entries) {
          if (type === vscode.FileType.File) {
            const filePath = path.join(buildDir, name);
            await deleteFile(filePath);
          }
        }
        logger.debug(CHANNEL, `Cleaned build directory: ${buildDir}`);
      } catch (err) {
        logger.error(
          CHANNEL,
          `Error cleaning build directory ${buildDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async function processDirectory(dirPath: string) {
    try {
      const entries = await readDirectory(dirPath);
      for (const [name, type] of entries) {
        if (
          type === vscode.FileType.Directory &&
          !EXCLUDED_DIRS.has(name.toLowerCase())
        ) {
          const fullPath = path.join(dirPath, name);
          await cleanBuildDir(fullPath);
          await processDirectory(fullPath);
        }
      }
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error processing directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    // Clean root build directory first
    await cleanBuildDir('.');
    // Then process subdirectories
    await processDirectory('.');
    logger.info(CHANNEL, 'Build directories cleaned');
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error cleaning build directories: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runCleanOutput(): Promise<void> {
  logger.debug(CHANNEL, 'Starting output directory cleanup');
  const filesToDelete = new Set<string>();
  const validExtensions = new Set(['.tex', '.pdf', '.xml']);

  const processDirectory = async (dirPath: string) => {
    try {
      const entries = await readDirectory(dirPath);
      for (const [name, type] of entries) {
        if (EXCLUDED_DIRS.has(name.toLowerCase())) {
          continue;
        }

        if (type === vscode.FileType.Directory) {
          await processDirectory(path.join(dirPath, name));
        } else if (type === vscode.FileType.File) {
          const ext = path.extname(name);
          if (validExtensions.has(ext)) {
            // Check if file matches any model pattern
            if (MODELS.some((model) => name.includes(`_${model}`))) {
              filesToDelete.add(path.join(dirPath, name));
            }
          }
        }
      }
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error processing directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  await processDirectory('.');

  for (const file of filesToDelete) {
    await deleteFile(file);
  }

  logger.info(CHANNEL, 'All AI Generated Output files cleaned');
}
