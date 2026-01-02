/**
 * Utility functions for consistent file operation result handling.
 *
 * This module provides standardized UI feedback for file operations (clean, pack, etc.)
 * with consistent logging and user notifications.
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { FileOpResult } from '@agent/types/ResultTypes';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

export interface FileOperationResultOptions {
  /** The logging channel to use */
  channel: string;
  /** Name of the operation for display (e.g., "cleanup", "pack") */
  operationName: string;
  /** Optional input file for context in messages */
  inputFile?: string;
  /**
   * If true and result has outputFolder, shows "Open Folder" action.
   * Used for operations like pack that produce output folders.
   */
  showOpenFolder?: boolean;
}

/**
 * Display standardized UI feedback for file operation results.
 *
 * Replaces the pattern of `showCleanResult()`, `showPackResult()`, and similar
 * scattered throughout commands. Logs all messages to the specified channel.
 *
 * @param result - The file operation result
 * @param options - Configuration for display and logging
 *
 * @example
 * ```typescript
 * // For cleanup operations
 * await showFileOperationResult(result, {
 *   channel: CHANNEL,
 *   operationName: 'cleanup',
 *   inputFile: config.inputFile,
 * });
 *
 * // For pack operations with folder reveal
 * await showFileOperationResult(result, {
 *   channel: CHANNEL,
 *   operationName: 'pack',
 *   inputFile: config.inputFile,
 *   showOpenFolder: true,
 * });
 * ```
 */
export async function showFileOperationResult(
  result: FileOpResult,
  options: FileOperationResultOptions,
): Promise<void> {
  const { channel, operationName, inputFile, showOpenFolder = false } = options;

  switch (result.status) {
    case 'success': {
      if (showOpenFolder && result.outputFolder) {
        const folder = result.outputFolder;
        const message = `Files ${operationName}ed into ${folder}`;
        logger.info(channel, message);
        const selection = await vscode.window.showInformationMessage(
          message,
          'Open Folder',
        );
        if (selection === 'Open Folder') {
          await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(WorkspaceFS.fullPath(folder)),
          );
        }
      } else {
        const message = inputFile
          ? `${capitalize(operationName)} complete for ${inputFile}`
          : `${capitalize(operationName)} complete`;
        logger.info(channel, message);
        await vscode.window.showInformationMessage(message);
      }
      break;
    }
    case 'noFiles': {
      const message = inputFile
        ? `No files found to ${operationName} for ${inputFile}`
        : `No files found to ${operationName}`;
      logger.info(channel, message);
      await vscode.window.showInformationMessage(message);
      break;
    }
    case 'missingParams': {
      const message = `Missing required parameters for ${operationName}`;
      logger.error(channel, message);
      await vscode.window.showErrorMessage(message);
      break;
    }
    case 'error': {
      const message = `Error during ${operationName}: ${result.error}`;
      logger.error(channel, message);
      await vscode.window.showErrorMessage(message);
      break;
    }
  }
}

/** Capitalize the first letter of a string */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
