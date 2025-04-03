// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import {
  showInfoMessage,
  showErrorMessage,
} from '../frontend-utils/commonUtils';
import { getWorkspacePath, getRelativePath } from '../utils/workspaceFileUtils';
import { listInputFiles } from '../frontend-utils/fileListingUtils';
import { getConfig } from '../utils/configUtils';
const CHANNEL = 'fileSelectionCommands';
logger.initialize(CHANNEL);

/**
 * Gets the default URI to use for file selection dialogs
 * @param currentFile The current file path (relative to workspace)
 * @returns The default URI to use, or null if no workspace is open
 */
function getDefaultUri(currentFile: string): vscode.Uri | null {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    return null;
  }

  return currentFile
    ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentFile)))
    : vscode.Uri.file(workspacePath);
}

export function registerFileSelectionCommands(
  context: vscode.ExtensionContext,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.selectInputFile',
      selectInputFile,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectInputFiles',
      selectInputFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectReferenceFiles',
      selectReferenceFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectAuxiliaryFiles',
      selectAuxiliaryFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMediaFiles',
      selectMediaFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMediaFile',
      selectMediaFile,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectOutputFiles',
      selectOutputFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectEditedFile',
      selectEditedFile,
    ),
    vscode.commands.registerCommand('coauthor.getCurrentFile', getCurrentFile),
    vscode.commands.registerCommand('coauthor.selectBaseFile', selectBaseFile),
    vscode.commands.registerCommand(
      'coauthor.refreshInputFiles',
      refreshInputFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.refreshBaseFiles',
      refreshBaseFiles,
    ),
  );
}

async function selectInputFile(
  currentInputFile: string,
): Promise<string | null> {
  const defaultUri = getDefaultUri(currentInputFile);
  if (!defaultUri) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const fileUri = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Select File',
    canSelectFiles: true,
    canSelectFolders: false,
    defaultUri: defaultUri,
    filters: {
      'Text files': getConfig<string[]>('files.included.inputExtensions').map(
        (ext) => ext.replace('.', ''),
      ),
    },
  });

  if (fileUri && fileUri[0]) {
    // Use simple relative path handling
    const relativePath = getRelativePath(fileUri[0].fsPath);
    // showInfoMessage(`Selected file: ${relativePath}`);
    logger.info(CHANNEL, `Selected file: ${relativePath}`);
    return relativePath;
  }
  return null;
}

async function selectInputFiles(
  currentInputFile: string,
): Promise<string[] | null> {
  const defaultUri = getDefaultUri(currentInputFile);
  if (!defaultUri) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const includedInputExtensions = getConfig<string[]>(
    'files.included.inputExtensions',
    ['.txt', '.tex', '.md'],
  );

  try {
    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Select Files',
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: defaultUri,
      filters: {
        'Text files': includedInputExtensions.map((ext) =>
          ext.replace('.', ''),
        ),
      },
    });

    if (!fileUris || fileUris.length === 0) {
      return null;
    }

    // Simplified path handling: just use the full relative path
    const relativePaths = fileUris.map((uri) => getRelativePath(uri.fsPath));

    showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
    logger.info(CHANNEL, `Selected files: ${relativePaths.join(', ')}`);
    return relativePaths;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error selecting files: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function selectReferenceFiles(
  currentReferenceFile: string,
): Promise<string[] | null> {
  const defaultUri = getDefaultUri(currentReferenceFile);
  if (!defaultUri) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const includedReferenceExtensions = getConfig<string[]>(
    'files.included.referenceExtensions',
  );

  const fileUris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Select Ref Files',
    canSelectFiles: true,
    canSelectFolders: false,
    defaultUri: defaultUri,
    filters: {
      'Text files': includedReferenceExtensions.map((ext) =>
        ext.replace('.', ''),
      ),
    },
  });

  if (fileUris && fileUris.length > 0) {
    const relativePaths = fileUris.map((uri) => getRelativePath(uri.fsPath));
    showInfoMessage(`Selected reference files: ${relativePaths.join(', ')}`);
    logger.info(
      CHANNEL,
      `Selected reference files: ${relativePaths.join(', ')}`,
    );
    return relativePaths;
  }
  return null;
}

async function selectAuxiliaryFiles(
  currentAuxiliaryFile: string,
): Promise<string[] | null> {
  const defaultUri = getDefaultUri(currentAuxiliaryFile);
  if (!defaultUri) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const includedAuxiliaryExtensions = getConfig<string[]>(
    'files.included.auxiliaryExtensions',
  );

  const fileUris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Select Auxiliary Files',
    canSelectFiles: true,
    canSelectFolders: false,
    defaultUri: defaultUri,
    filters: {
      'Text files': includedAuxiliaryExtensions.map((ext) =>
        ext.replace('.', ''),
      ),
    },
  });

  if (fileUris && fileUris.length > 0) {
    const relativePaths = fileUris.map((uri) => getRelativePath(uri.fsPath));
    showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
    logger.info(CHANNEL, `Selected files: ${relativePaths.join(', ')}`);
    return relativePaths;
  }
  return null;
}

async function selectMediaFiles(
  currentMediaFile: string,
): Promise<string[] | null> {
  const defaultUri = getDefaultUri(currentMediaFile);
  if (!defaultUri) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const includedFigureExtensions = getConfig<string[]>(
    'files.included.mediaExtensions',
  );
  const includedAudioExtensions = getConfig<string[]>(
    'files.included.audioExtensions',
  );

  const fileUris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Select Media',
    canSelectFiles: true,
    canSelectFolders: false,
    defaultUri: defaultUri,
    filters: {
      'Image files': includedFigureExtensions.map((ext) =>
        ext.replace('.', ''),
      ),
      'Audio files': includedAudioExtensions.map((ext) => ext.replace('.', '')),
    },
  });

  if (fileUris && fileUris.length > 0) {
    // Simplified path handling: just use the full relative path
    const relativePaths = fileUris.map((uri) => getRelativePath(uri.fsPath));

    showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
    logger.info(CHANNEL, `Selected files: ${relativePaths.join(', ')}`);
    return relativePaths;
  }
  return null;
}

async function selectMediaFile(): Promise<string | null> {
  const fileUri = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Select Media File',
    canSelectFiles: true,
    canSelectFolders: false,
    filters: {
      Images: getConfig<string[]>('files.included.mediaExtensions').map((ext) =>
        ext.replace('.', ''),
      ),
      'Audio files': getConfig<string[]>('files.included.audioExtensions').map(
        (ext) => ext.replace('.', ''),
      ),
    },
  });
  if (fileUri && fileUri[0]) {
    const relativePath = getRelativePath(fileUri[0].fsPath);
    showInfoMessage(`Selected media file: ${relativePath}`);
    logger.info(CHANNEL, `Selected media file: ${relativePath}`);
    return relativePath;
  }
  return null;
}

async function selectOutputFiles(
  currentInputFile: string,
): Promise<string[] | null> {
  const defaultUri = getDefaultUri(currentInputFile);
  if (!defaultUri) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  try {
    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Select Output Files',
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: defaultUri,
      filters: {
        'Text files': ['tex', 'txt', 'md'],
      },
    });

    if (!fileUris || fileUris.length === 0) {
      return null;
    }

    const relativePaths = fileUris.map((uri) => getRelativePath(uri.fsPath));
    logger.info(CHANNEL, `Selected output files: ${relativePaths.join(', ')}`);
    vscode.window.showInformationMessage(
      `Selected output files: ${relativePaths.join(', ')}`,
    );
    return relativePaths;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error selecting output files: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(
      `Error selecting output files: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function selectEditedFile(): Promise<string | null> {
  const fileUri = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Select Edited File',
    canSelectFiles: true,
    canSelectFolders: false,
  });
  if (fileUri && fileUri[0]) {
    const relativePath = getRelativePath(fileUri[0].fsPath);
    showInfoMessage(`Selected edited file: ${relativePath}`);
    logger.info(CHANNEL, `Selected edited file: ${relativePath}`);
    return relativePath;
  }
  return null;
}

async function getCurrentFile(): Promise<string | null> {
  const currentFile = vscode.window.activeTextEditor?.document;
  if (currentFile && currentFile.uri.scheme === 'file') {
    return getRelativePath(currentFile.uri.fsPath);
  }
  return null;
}

async function selectBaseFile(): Promise<string | null> {
  const baseFile = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Select Base File',
    filters: {
      'Text files': getConfig<string[]>('files.included.inputExtensions').map(
        (ext) => ext.replace('.', ''),
      ),
    },
  });
  if (baseFile && baseFile[0]) {
    return getRelativePath(baseFile[0].fsPath);
  }
  return null;
}

async function refreshInputFiles(): Promise<string[]> {
  return await listInputFiles();
}

async function refreshBaseFiles(): Promise<string[]> {
  return await listInputFiles();
}

export const fileSelectionCommands = {
  selectInputFile,
  selectInputFiles,
  selectReferenceFiles,
  selectAuxiliaryFiles,
  selectMediaFiles,
  selectMediaFile,
  selectOutputFiles,
  selectEditedFile,
  getCurrentFile,
  selectBaseFile,
  refreshInputFiles,
  refreshBaseFiles,
};
