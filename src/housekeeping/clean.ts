// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - result types
import type { FileOpResult } from '@/types/ResultTypes';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

// Local imports - housekeeping
import {
  EXCLUDED_DIRS,
  TEMP_EXTENSIONS,
  PACK_EXTENSIONS,
  MODELS,
} from './constants';
import { runOperationSingle, runOperationMultiple } from './fileOps';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);
export async function runCleanSingle(
  model: string,
  inputFile: string,
  agent: string,
): Promise<FileOpResult> {
  return runOperationSingle({ operation: 'clean', model, inputFile, agent });
}

export async function runCleanMultiple(
  model: string,
  inputFile: string,
  agent: string,
  inputFiles: string[],
): Promise<FileOpResult> {
  return runOperationMultiple({
    operation: 'clean',
    model,
    inputFile,
    agent,
    inputFiles,
  });
}

export async function runCleanBuild(): Promise<void> {
  logger.debug(CHANNEL, 'Starting build directory cleanup');

  async function cleanBuildDir(directory: string) {
    const buildDir = path.join(directory, 'build');
    if (await WorkspaceFS.exists(buildDir)) {
      try {
        const entries = await WorkspaceFS.readDir(buildDir);
        // First delete all files
        for (const [name, type] of entries) {
          const fullPath = path.join(buildDir, name);
          if (type === vscode.FileType.File) {
            await WorkspaceFS.delete(fullPath);
          } else if (type === vscode.FileType.Directory) {
            const subEntries = await WorkspaceFS.readDir(fullPath);
            if (subEntries.length === 0) {
              await WorkspaceFS.delete(fullPath);
              logger.debug(CHANNEL, `Removed empty directory: ${fullPath}`);
            }
            for (const [name, type] of subEntries) {
              if (type === vscode.FileType.Directory) {
                const subPath = path.join(fullPath, name);
                const stats = await vscode.workspace.fs.stat(
                  vscode.Uri.file(subPath),
                );
                const size = stats.size;
                if (size === 0) {
                  await WorkspaceFS.delete(subPath);
                  logger.debug(CHANNEL, `Removed empty directory: ${subPath}`);
                }
              }
            }
          }
        }
        // Check if build directory itself is empty
        const remainingEntries = await WorkspaceFS.readDir(buildDir);
        if (remainingEntries.length === 0) {
          await vscode.workspace.fs.delete(vscode.Uri.file(buildDir), {
            recursive: true,
          });
          logger.debug(CHANNEL, `Removed empty build directory: ${buildDir}`);
        } else {
          logger.debug(CHANNEL, `Cleaned build directory: ${buildDir}`);
        }
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
      const entries = await WorkspaceFS.readDir(dirPath);
      for (const [name, type] of entries) {
        if (
          type === vscode.FileType.Directory &&
          !EXCLUDED_DIRS.has(name.toLowerCase())
          // this excludes the build directory, is it correct?
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
      const entries = await WorkspaceFS.readDir(dirPath);
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
    await WorkspaceFS.delete(file);
  }

  logger.info(CHANNEL, 'All AI Generated Output files cleaned');
}
