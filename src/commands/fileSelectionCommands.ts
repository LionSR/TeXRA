// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import {
  showInfoMessage,
  showErrorMessage,
} from '../frontend-utils/commonUtils';
import { getRelativePath } from '../utils/workspaceFileUtils';
import { listInputFiles } from '../frontend-utils/fileListingUtils';
import { getConfig } from '../utils/configUtils';
import { selectFile, selectFiles } from '../utils/fileDialogUtils';
const CHANNEL = 'fileSelectionCommands';
logger.initialize(CHANNEL);

export function registerFileSelectionCommands(
  context: vscode.ExtensionContext,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.selectInputFile', selectInputFile),
    vscode.commands.registerCommand('texra.selectInputFiles', selectInputFiles),
    vscode.commands.registerCommand(
      'texra.selectReferenceFiles',
      selectReferenceFiles,
    ),
    vscode.commands.registerCommand(
      'texra.selectAuxiliaryFiles',
      selectAuxiliaryFiles,
    ),
    vscode.commands.registerCommand('texra.selectMediaFiles', selectMediaFiles),
    vscode.commands.registerCommand('texra.selectMediaFile', selectMediaFile),
    vscode.commands.registerCommand(
      'texra.selectOutputFiles',
      selectOutputFiles,
    ),
    vscode.commands.registerCommand('texra.selectEditedFile', selectEditedFile),
    vscode.commands.registerCommand('texra.getCurrentFile', getCurrentFile),
    vscode.commands.registerCommand('texra.selectBaseFile', selectBaseFile),
    vscode.commands.registerCommand(
      'texra.refreshInputFiles',
      refreshInputFiles,
    ),
    vscode.commands.registerCommand('texra.refreshBaseFiles', refreshBaseFiles),
  );
}

async function selectInputFile(
  currentInputFile: string,
): Promise<string | null> {
  const result = await selectFile({
    currentFile: currentInputFile,
    openLabel: 'Select File',
    filters: {
      'Text files': getConfig<string[]>('files.included.inputExtensions').map(
        (ext) => ext.replace('.', ''),
      ),
    },
  });
  if (result) {
    logger.info(CHANNEL, `Selected file: ${result}`);
  }
  return result;
}

async function selectInputFiles(
  currentInputFile: string,
): Promise<string[] | null> {
  const includedInputExtensions = getConfig<string[]>(
    'files.included.inputExtensions',
    ['.txt', '.tex', '.md'],
  );

  try {
    const relativePaths = await selectFiles({
      currentFile: currentInputFile,
      allowMany: true,
      openLabel: 'Select Files',
      filters: {
        'Text files': includedInputExtensions.map((ext) =>
          ext.replace('.', ''),
        ),
      },
    });

    if (!relativePaths) {
      return null;
    }

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
  const includedReferenceExtensions = getConfig<string[]>(
    'files.included.referenceExtensions',
  );
  const relativePaths = await selectFiles({
    currentFile: currentReferenceFile,
    allowMany: true,
    openLabel: 'Select Ref Files',
    filters: {
      'Text files': includedReferenceExtensions.map((ext) =>
        ext.replace('.', ''),
      ),
    },
  });

  if (relativePaths) {
    showInfoMessage(`Selected reference files: ${relativePaths.join(', ')}`);
    logger.info(
      CHANNEL,
      `Selected reference files: ${relativePaths.join(', ')}`,
    );
  }

  return relativePaths;
}

async function selectAuxiliaryFiles(
  currentAuxiliaryFile: string,
): Promise<string[] | null> {
  const includedAuxiliaryExtensions = getConfig<string[]>(
    'files.included.auxiliaryExtensions',
  );
  const relativePaths = await selectFiles({
    currentFile: currentAuxiliaryFile,
    allowMany: true,
    openLabel: 'Select Auxiliary Files',
    filters: {
      'Text files': includedAuxiliaryExtensions.map((ext) =>
        ext.replace('.', ''),
      ),
    },
  });

  if (relativePaths) {
    showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
    logger.info(CHANNEL, `Selected files: ${relativePaths.join(', ')}`);
  }
  return relativePaths;
}

async function selectMediaFiles(
  currentMediaFile: string,
): Promise<string[] | null> {
  const includedFigureExtensions = getConfig<string[]>(
    'files.included.mediaExtensions',
    [],
  );
  const includedAudioExtensions = getConfig<string[]>(
    'files.included.audioExtensions',
    [],
  );
  const relativePaths = await selectFiles({
    currentFile: currentMediaFile,
    allowMany: true,
    openLabel: 'Select Media',
    filters: {
      'Image files': includedFigureExtensions.map((ext) =>
        ext.replace('.', ''),
      ),
      'Audio files': includedAudioExtensions.map((ext) => ext.replace('.', '')),
    },
  });

  if (relativePaths) {
    showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
    logger.info(CHANNEL, `Selected files: ${relativePaths.join(', ')}`);
  }
  return relativePaths;
}

async function selectMediaFile(): Promise<string | null> {
  const result = await selectFile({
    openLabel: 'Select Media File',
    filters: {
      Images: getConfig<string[]>('files.included.mediaExtensions', []).map(
        (ext) => ext.replace('.', ''),
      ),
      'Audio files': getConfig<string[]>(
        'files.included.audioExtensions',
        [],
      ).map((ext) => ext.replace('.', '')),
    },
  });
  if (result) {
    showInfoMessage(`Selected media file: ${result}`);
    logger.info(CHANNEL, `Selected media file: ${result}`);
  }
  return result;
}

async function selectOutputFiles(
  currentInputFile: string,
): Promise<string[] | null> {
  try {
    const relativePaths = await selectFiles({
      currentFile: currentInputFile,
      allowMany: true,
      openLabel: 'Select Output Files',
      filters: {
        'Text files': ['tex', 'txt', 'md'],
      },
    });

    if (!relativePaths) {
      return null;
    }

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
  const result = await selectFile({
    openLabel: 'Select Edited File',
    filters: {},
  });
  if (result) {
    showInfoMessage(`Selected edited file: ${result}`);
    logger.info(CHANNEL, `Selected edited file: ${result}`);
  }
  return result;
}

async function getCurrentFile(): Promise<string | null> {
  const currentFile = vscode.window.activeTextEditor?.document;
  if (currentFile && currentFile.uri.scheme === 'file') {
    return getRelativePath(currentFile.uri.fsPath);
  }
  return null;
}

async function selectBaseFile(): Promise<string | null> {
  const result = await selectFile({
    openLabel: 'Select Base File',
    filters: {
      'Text files': getConfig<string[]>('files.included.inputExtensions').map(
        (ext) => ext.replace('.', ''),
      ),
    },
  });
  return result ?? null;
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
