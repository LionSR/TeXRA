// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import { showLoggedErrorMessage } from '@common/errors';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { fileLister } from '@frontend/files';
import { selectFile, selectFiles } from '@frontend/ui/dialogs';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'fileSelectionCommands';
logger.initialize(CHANNEL);

interface PickerOptions<Many extends boolean> {
  allowMany: Many;
  openLabel: string;
  filters: () => { [name: string]: string[] };
}

/** Conditional return type for file picker functions */
type PickerResult<Many extends boolean> = Many extends true
  ? string[] | null
  : string | null;

function createPicker<Many extends boolean>(options: PickerOptions<Many>) {
  return async (currentFile?: string): Promise<PickerResult<Many>> => {
    // TypeScript cannot narrow conditional types at runtime, so we need this cast
    const nullResult = null as PickerResult<Many>;

    try {
      const baseOpts = {
        currentFile,
        openLabel: options.openLabel,
        filters: options.filters(),
      };

      const result = options.allowMany
        ? await selectFiles({ ...baseOpts, allowMany: true })
        : await selectFile(baseOpts);

      if (!result) {
        return nullResult;
      }

      const message = Array.isArray(result)
        ? `Selected files: ${result.join(', ')}`
        : `Selected file: ${result}`;
      vscode.window.showInformationMessage(message);
      logger.info(CHANNEL, message);
      return result as PickerResult<Many>;
    } catch (err) {
      await showLoggedErrorMessage(CHANNEL, 'Error selecting files', err);
      return nullResult;
    }
  };
}

export function registerFileSelectionCommands(
  context: vscode.ExtensionContext,
): void {
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
    vscode.commands.registerCommand('texra.refreshInputFiles', () =>
      fileLister.list('input'),
    ),
    vscode.commands.registerCommand('texra.refreshBaseFiles', () =>
      fileLister.list('input'),
    ),
  );
}

const selectInputFile = createPicker({
  allowMany: false,
  openLabel: 'Select File',
  filters: () => ({
    'Text files': getIncludedExtensions('input').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
});

const selectInputFiles = createPicker({
  allowMany: true,
  openLabel: 'Select Files',
  filters: () => ({
    'Text files': getIncludedExtensions('input', ['.txt', '.tex', '.md']).map(
      (ext) => ext.replace('.', ''),
    ),
  }),
});

const selectReferenceFiles = createPicker({
  allowMany: true,
  openLabel: 'Select Ref Files',
  filters: () => ({
    'Text files': getIncludedExtensions('reference').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
});

const selectAuxiliaryFiles = createPicker({
  allowMany: true,
  openLabel: 'Select Auxiliary Files',
  filters: () => ({
    'Text files': getIncludedExtensions('auxiliary').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
});

const selectMediaFiles = createPicker({
  allowMany: true,
  openLabel: 'Select Media',
  filters: () => ({
    'Image files': getIncludedExtensions('media').map((ext) =>
      ext.replace('.', ''),
    ),
    'Audio files': getIncludedExtensions('audio').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
});

const selectMediaFile = createPicker({
  allowMany: false,
  openLabel: 'Select Media File',
  filters: () => ({
    Images: getIncludedExtensions('media').map((ext) => ext.replace('.', '')),
    'Audio files': getIncludedExtensions('audio').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
});

const selectOutputFiles = createPicker({
  allowMany: true,
  openLabel: 'Select Output Files',
  filters: () => ({ 'Text files': ['tex', 'txt', 'md'] }),
});

const selectEditedFile = createPicker({
  allowMany: false,
  openLabel: 'Select Edited File',
  filters: () => ({}),
});

async function getCurrentFile(): Promise<string | null> {
  // Try activeTextEditor first (for text files)
  const currentFile = vscode.window.activeTextEditor?.document;
  if (currentFile && currentFile.uri.scheme === 'file') {
    return WorkspaceFS.relativePath(currentFile.uri.fsPath);
  }
  // Fallback to active tab (for media files like images, PDFs)
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab?.input) {
    const input = activeTab.input;
    if (
      (input instanceof vscode.TabInputText ||
        input instanceof vscode.TabInputCustom) &&
      input.uri.scheme === 'file'
    ) {
      return WorkspaceFS.relativePath(input.uri.fsPath);
    }
  }
  return null;
}

const selectBaseFile = createPicker({
  allowMany: false,
  openLabel: 'Select Base File',
  filters: () => ({
    'Text files': getIncludedExtensions('input').map((ext) =>
      ext.replace('.', ''),
    ),
  }),
});
