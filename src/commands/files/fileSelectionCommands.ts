// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { showInfoMessage, showErrorMessage } from '@frontend/ui/messageUtils';
import { WorkspaceFileManager } from '@utils/files';
import { listInputFiles } from '@frontend/files/FileLister';
import { getIncludedExtensions, FileType } from '@utils/fileTypeUtils';
import { selectFile, selectFiles } from '@frontend/files/dialog';
const CHANNEL = 'fileSelectionCommands';
logger.initialize(CHANNEL);

function createPicker(options: {
  label: string;
  types: FileType[];
  allowMany?: boolean;
}) {
  return async function (
    currentFile: string,
  ): Promise<string[] | string | null> {
    try {
      const exts = options.types
        .flatMap((t) =>
          t === 'input'
            ? getIncludedExtensions(t, ['.txt', '.tex', '.md'])
            : getIncludedExtensions(t),
        )
        .map((ext) => ext.replace('.', ''));
      const dialog = options.allowMany ? selectFiles : selectFile;
      const result: any = await dialog({
        currentFile,
        allowMany: options.allowMany,
        openLabel: options.label,
        filters: { Files: exts },
      });
      if (!result) {
        return null;
      }
      const message = Array.isArray(result)
        ? `Selected files: ${result.join(', ')}`
        : `Selected file: ${result}`;
      showInfoMessage(message);
      logger.info(CHANNEL, message);
      return result;
    } catch (err) {
      const msg = `Error selecting files: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(CHANNEL, msg);
      showErrorMessage(msg);
      return null;
    }
  };
}

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

const selectInputFile = createPicker({
  label: 'Select File',
  types: ['input'],
});

const selectInputFiles = createPicker({
  label: 'Select Files',
  types: ['input'],
  allowMany: true,
});

const selectReferenceFiles = createPicker({
  label: 'Select Ref Files',
  types: ['reference'],
  allowMany: true,
});

const selectAuxiliaryFiles = createPicker({
  label: 'Select Auxiliary Files',
  types: ['auxiliary'],
  allowMany: true,
});

const selectMediaFiles = createPicker({
  label: 'Select Media',
  types: ['media', 'audio'],
  allowMany: true,
});

const selectMediaFile = createPicker({
  label: 'Select Media File',
  types: ['media', 'audio'],
});

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

const selectEditedFile = createPicker({
  label: 'Select Edited File',
  types: [],
});

async function getCurrentFile(): Promise<string | null> {
  const currentFile = vscode.window.activeTextEditor?.document;
  if (currentFile && currentFile.uri.scheme === 'file') {
    return WorkspaceFileManager.getRelativePath(currentFile.uri.fsPath);
  }
  return null;
}

const selectBaseFile = createPicker({
  label: 'Select Base File',
  types: ['input'],
});

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
