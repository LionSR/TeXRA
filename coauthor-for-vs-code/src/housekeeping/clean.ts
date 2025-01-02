import * as vscode from 'vscode';
import * as path from 'path';
import { debug, info, warn, error } from '../logger/logUtils';
import {
  deleteFile,
  readDirectory,
  fileExists,
  findFileInBuild,
} from '../utils/fileUtils';
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
  info(
    CHANNEL,
    `Starting cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );

  if (!inputFile || !model || !agent) {
    error(
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
  debug(CHANNEL, `Parsed paths: baseName=${baseName}, inputDir=${inputDir}`);

  const agentFirstNameChunk = getAgentFirstNameChunk(agent);
  const filePatterns = getFilePatterns(baseName, model, agentFirstNameChunk);
  debug(CHANNEL, `Generated patterns: ${filePatterns}`);

  const extensions = [...TEMP_EXTENSIONS, ...PACK_EXTENSIONS];
  debug(CHANNEL, `Using extensions: ${extensions}`);

  let filesFound = false;
  for (const pattern of filePatterns) {
    for (const ext of extensions) {
      const filePath = await findFileInBuild(inputDir, pattern, ext);
      if (filePath) {
        debug(CHANNEL, `Found file to delete: ${filePath}`);
        filesFound = true;
        await deleteFile(filePath);
      }
    }
  }

  if (!filesFound) {
    warn(CHANNEL, `No matching files found to clean for ${inputFile}`);
    vscode.window.showInformationMessage(
      `No files found to clean for ${inputFile}`,
    );
  } else {
    info(CHANNEL, `Cleanup complete for ${inputFile}`);
    vscode.window.showInformationMessage(`Cleanup complete for ${inputFile}`);
  }
}

export async function runCleanMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
): Promise<void> {
  debug(
    CHANNEL,
    `Starting multiple cleanup with model=${model}, inputFile=${inputFile}, agent=${agent}`,
  );
  debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  await runCleanSingle(model, inputFile, agent);

  if (inputFiles && inputFiles.length > 0) {
    for (const file of inputFiles) {
      await runCleanSingle(model, file, agent);
    }
  }

  info(CHANNEL, 'Cleanup complete for multiple files.');
}

export async function runCleanBuild(): Promise<void> {
  debug(CHANNEL, 'Starting build directory cleanup');

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
        debug(CHANNEL, `Cleaned build directory: ${buildDir}`);
      } catch (err) {
        error(
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
      error(
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
    info(CHANNEL, 'Build directories cleaned');
  } catch (err) {
    error(
      CHANNEL,
      `Error cleaning build directories: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function runCleanOutput(): Promise<void> {
  debug(CHANNEL, 'Starting output directory cleanup');
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
      error(
        CHANNEL,
        `Error processing directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  await processDirectory('.');

  for (const file of filesToDelete) {
    await deleteFile(file);
  }

  info(CHANNEL, 'All AI Generated Output files cleaned');
}
