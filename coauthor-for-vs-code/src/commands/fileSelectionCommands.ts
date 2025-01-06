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
  getConfig,
} from '../frontend-utils/commonUtils';
import { getWorkspacePath, getRelativePath } from '../utils/fileUtils';
import { listInputFiles } from '../frontend-utils/fileListingUtils';

const CHANNEL = 'Commands';
logger.initialize(CHANNEL);

export function registerFileSelectionCommands(
  context: vscode.ExtensionContext,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.selectInputFile',
      selectInputFile,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMultipleInputFiles',
      selectMultipleInputFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMultipleReferenceFiles',
      selectMultipleReferenceFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMultipleAuxiliaryFiles',
      selectMultipleAuxiliaryFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMultipleFigureFiles',
      selectMultipleFigureFiles,
    ),
    vscode.commands.registerCommand(
      'coauthor.selectFigureFile',
      selectFigureFile,
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
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const defaultUri = currentInputFile
    ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentInputFile)))
    : vscode.Uri.file(workspacePath);

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
    const relativePath = getRelativePath(fileUri[0].fsPath);
    showInfoMessage(`Selected file: ${relativePath}`);
    logger.info(CHANNEL, `Selected file: ${relativePath}`);
    return relativePath;
  }
  return null;
}

async function selectMultipleInputFiles(
  currentInputFile: string,
): Promise<string[] | null> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const defaultUri = currentInputFile
    ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentInputFile)))
    : vscode.Uri.file(workspacePath);

  const includedInputDirectories = getConfig<string[]>(
    'files.included.inputDirectories',
    [],
  );
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

    if (!fileUris || fileUris.length === 0) return null;

    const relativePaths = fileUris.map((uri) => {
      const relativePath = getRelativePath(uri.fsPath);
      const pathParts = relativePath.split(path.sep);
      const startIndex = pathParts.findIndex((part) =>
        includedInputDirectories.includes(part),
      );
      return startIndex !== -1
        ? pathParts.slice(startIndex).join(path.sep)
        : relativePath;
    });

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

async function selectMultipleReferenceFiles(
  currentReferenceFile: string,
): Promise<string[] | null> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const defaultUri = currentReferenceFile
    ? vscode.Uri.file(
        path.dirname(path.join(workspacePath, currentReferenceFile)),
      )
    : vscode.Uri.file(workspacePath);

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

async function selectMultipleAuxiliaryFiles(
  currentAuxiliaryFile: string,
): Promise<string[] | null> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const defaultUri = currentAuxiliaryFile
    ? vscode.Uri.file(
        path.dirname(path.join(workspacePath, currentAuxiliaryFile)),
      )
    : vscode.Uri.file(workspacePath);

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

async function selectMultipleFigureFiles(
  currentFigureFile: string,
): Promise<string[] | null> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    showErrorMessage('No workspace folder open');
    return null;
  }

  const defaultUri = currentFigureFile
    ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentFigureFile)))
    : vscode.Uri.file(workspacePath);

  const includedFigureDirectories = getConfig<string[]>(
    'files.included.figureDirectories',
  );
  const includedFigureExtensions = getConfig<string[]>(
    'files.included.figureExtensions',
  );

  const fileUris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Select Figures',
    canSelectFiles: true,
    canSelectFolders: false,
    defaultUri: defaultUri,
    filters: {
      'Image files': includedFigureExtensions.map((ext) =>
        ext.replace('.', ''),
      ),
    },
  });

  if (fileUris && fileUris.length > 0) {
    const relativePaths = fileUris.map((uri) => {
      const relativePath = getRelativePath(uri.fsPath);
      const pathParts = relativePath.split(path.sep);
      const startIndex = pathParts.findIndex((part) =>
        includedFigureDirectories.includes(part),
      );
      return startIndex !== -1
        ? pathParts.slice(startIndex).join(path.sep)
        : relativePath;
    });
    showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
    logger.info(CHANNEL, `Selected files: ${relativePaths.join(', ')}`);
    return relativePaths;
  }
  return null;
}

async function selectFigureFile(): Promise<string | null> {
  const fileUri = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Select Figure File',
    canSelectFiles: true,
    canSelectFolders: false,
    filters: {
      Images: getConfig<string[]>('files.included.figureExtensions').map(
        (ext) => ext.replace('.', ''),
      ),
    },
  });
  if (fileUri && fileUri[0]) {
    const relativePath = getRelativePath(fileUri[0].fsPath);
    showInfoMessage(`Selected figure file: ${relativePath}`);
    logger.info(CHANNEL, `Selected figure file: ${relativePath}`);
    return relativePath;
  }
  return null;
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
  selectMultipleInputFiles,
  selectMultipleReferenceFiles,
  selectMultipleAuxiliaryFiles,
  selectMultipleFigureFiles,
  selectFigureFile,
  selectEditedFile,
  getCurrentFile,
  selectBaseFile,
  refreshInputFiles,
  refreshBaseFiles,
};
