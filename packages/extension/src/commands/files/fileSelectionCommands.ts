// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import { FILE_SELECTION_COMMAND_IDS, getFilterExtensions } from '@common/files';
import { getFileLister } from '@frontend/files';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
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
    vscode.commands.registerCommand(
      FILE_SELECTION_COMMAND_IDS.selectInputFiles,
      selectInputFiles,
    ),
    vscode.commands.registerCommand(
      FILE_SELECTION_COMMAND_IDS.selectContextFiles,
      selectContextFiles,
    ),
    vscode.commands.registerCommand(
      FILE_SELECTION_COMMAND_IDS.selectMediaFiles,
      selectMediaFiles,
    ),
    vscode.commands.registerCommand(
      FILE_SELECTION_COMMAND_IDS.selectOutputFiles,
      selectOutputFiles,
    ),
    vscode.commands.registerCommand(
      FILE_SELECTION_COMMAND_IDS.selectEditedFile,
      selectEditedFile,
    ),
    vscode.commands.registerCommand(
      FILE_SELECTION_COMMAND_IDS.getCurrentFile,
      getCurrentFile,
    ),
    vscode.commands.registerCommand(
      FILE_SELECTION_COMMAND_IDS.selectBaseFile,
      selectBaseFile,
    ),
    vscode.commands.registerCommand(
      FILE_SELECTION_COMMAND_IDS.refreshInputFiles,
      () => getFileLister().list('input'),
    ),
    vscode.commands.registerCommand(
      FILE_SELECTION_COMMAND_IDS.refreshBaseFiles,
      () => getFileLister().list('input'),
    ),
  );
}

const selectInputFiles = createPicker({
  allowMany: true,
  openLabel: 'Select Files',
  filters: () => ({
    'Text files': getFilterExtensions('input'),
  }),
});

const selectContextFiles = createPicker({
  allowMany: true,
  openLabel: 'Select Context Files',
  filters: () => ({
    'Text files': getFilterExtensions('context'),
  }),
});

const selectMediaFiles = createPicker({
  allowMany: true,
  openLabel: 'Select Media',
  filters: () => ({
    'Image files': getFilterExtensions('media'),
    'Audio files': getFilterExtensions('audio'),
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
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file') {
    return WorkspaceFS.relativePath(doc.uri.fsPath);
  }

  // Fallback to active tab (for media files like images, PDFs)
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const isFileInput =
    (input instanceof vscode.TabInputText ||
      input instanceof vscode.TabInputCustom) &&
    input.uri.scheme === 'file';

  return isFileInput ? WorkspaceFS.relativePath(input.uri.fsPath) : null;
}

const selectBaseFile = createPicker({
  allowMany: false,
  openLabel: 'Select Base File',
  filters: () => ({
    'Text files': getFilterExtensions('input'),
  }),
});
