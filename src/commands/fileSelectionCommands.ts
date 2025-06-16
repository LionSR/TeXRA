// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { showInfoMessage, showErrorMessage } from '../frontend/ui/messageUtils';
import { getRelativePath } from '@utils/files';
import { listInputFiles } from '../frontend/files/fileLister';
import { getIncludedExtensions } from '@utils/fileTypeUtils';
import { selectFile, selectFiles } from '../frontend/files/dialog';
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

function createPicker(
  openLabel: string,
  allowMany: true,
  filters: () => Record<string, string[]>,
  success: (selection: string[]) => string,
): (currentFile?: string) => Promise<string[] | null>;
function createPicker(
  openLabel: string,
  allowMany: false,
  filters: () => Record<string, string[]>,
  success: (selection: string) => string,
): (currentFile?: string) => Promise<string | null>;
function createPicker<T extends string | string[]>(
  openLabel: string,
  allowMany: boolean,
  filters: () => Record<string, string[]>,
  success: (selection: T) => string,
): (currentFile?: string) => Promise<T | null> {
  return async (currentFile = '') => {
    try {
      const opts = {
        currentFile,
        allowMany,
        openLabel,
        filters: filters(),
      };
      const result = allowMany
        ? await selectFiles(opts)
        : await selectFile(opts);
      if (result) {
        const message = success(result as T);
        showInfoMessage(message);
        logger.info(CHANNEL, message);
      }
      return (result ?? null) as T | null;
    } catch (err) {
      const errorMsg = `Error selecting files: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(CHANNEL, errorMsg);
      showErrorMessage(errorMsg);
      return null;
    }
  };
}

const selectInputFile = createPicker(
  'Select File',
  false,
  () => ({
    'Text files': getIncludedExtensions('input', ['.txt', '.tex', '.md']).map(
      (ext) => ext.replace('.', ''),
    ),
  }),
  (file) => `Selected file: ${file}`,
);

const selectInputFiles = createPicker(
  'Select Files',
  true,
  () => ({
    'Text files': getIncludedExtensions('input', ['.txt', '.tex', '.md']).map(
      (ext) => ext.replace('.', ''),
    ),
  }),
  (files) => `Selected files: ${(files as string[]).join(', ')}`,
);

const selectReferenceFiles = createPicker(
  'Select Ref Files',
  true,
  () => ({
    'Text files': getIncludedExtensions('reference').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
  (files) => `Selected reference files: ${(files as string[]).join(', ')}`,
);

const selectAuxiliaryFiles = createPicker(
  'Select Auxiliary Files',
  true,
  () => ({
    'Text files': getIncludedExtensions('auxiliary').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
  (files) => `Selected files: ${(files as string[]).join(', ')}`,
);

const selectMediaFiles = createPicker(
  'Select Media',
  true,
  () => ({
    'Image files': getIncludedExtensions('media').map((ext) =>
      ext.replace('.', ''),
    ),
    'Audio files': getIncludedExtensions('audio').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
  (files) => `Selected files: ${(files as string[]).join(', ')}`,
);

const selectMediaFile = createPicker(
  'Select Media File',
  false,
  () => ({
    Images: getIncludedExtensions('media').map((ext) => ext.replace('.', '')),
    'Audio files': getIncludedExtensions('audio').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
  (file) => `Selected media file: ${file}`,
);

const selectOutputFiles = createPicker(
  'Select Output Files',
  true,
  () => ({
    'Text files': ['tex', 'txt', 'md'],
  }),
  (files) => `Selected output files: ${(files as string[]).join(', ')}`,
);

const selectEditedFile = createPicker(
  'Select Edited File',
  false,
  () => ({}),
  (file) => `Selected edited file: ${file}`,
);

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
      'Text files': getIncludedExtensions('input').map((ext) =>
        ext.replace('.', ''),
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
