// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { getFilterExtensions } from '@common/files/fileTypeUtils';
import { FILE_SELECTION_COMMAND_IDS } from '@frontend/files/fileSelectionRegistry';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { selectFiles } from '@frontend/ui/dialogs';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';

const CHANNEL = 'fileSelectionCommands';

interface PickerOptions {
  openLabel: string;
  filters: () => { [name: string]: string[] };
}

/** Run a dialog, announce what was picked, and report failures once. */
async function announceSelection<T extends string | string[]>(
  select: () => Promise<T | null>,
): Promise<T | null> {
  try {
    const result = await select();
    if (!result) {
      return null;
    }

    const message = Array.isArray(result)
      ? `Selected files: ${result.join(', ')}`
      : `Selected file: ${result}`;
    vscode.window.showInformationMessage(message);
    logger.info(CHANNEL, message);
    return result;
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'File selection failed. See the TeXRA log for details.',
      err,
    );
    return null;
  }
}

function createMultiPicker(
  options: PickerOptions,
): (currentFile?: string) => Promise<string[] | null> {
  return (currentFile) =>
    announceSelection(() =>
      selectFiles({
        currentFile,
        openLabel: options.openLabel,
        filters: options.filters(),
        allowMany: true,
      }),
    );
}

export function registerFileSelectionCommands(
  context: vscode.ExtensionContext,
): void {
  registerCommandEntries(context, [
    {
      id: FILE_SELECTION_COMMAND_IDS.selectInputFiles,
      handler: selectInputFiles,
    },
    {
      id: FILE_SELECTION_COMMAND_IDS.selectContextFiles,
      handler: selectContextFiles,
    },
    {
      id: FILE_SELECTION_COMMAND_IDS.selectMediaFiles,
      handler: selectMediaFiles,
    },
    {
      id: FILE_SELECTION_COMMAND_IDS.selectOutputFiles,
      handler: selectOutputFiles,
    },
    {
      id: FILE_SELECTION_COMMAND_IDS.selectEditedFile,
      handler: selectEditedFile,
    },
    { id: FILE_SELECTION_COMMAND_IDS.getCurrentFile, handler: getCurrentFile },
  ]);
}

const selectInputFiles = createMultiPicker({
  openLabel: 'Select Files',
  filters: () => ({
    'Text files': getFilterExtensions('input'),
  }),
});

const selectContextFiles = createMultiPicker({
  openLabel: 'Select Context Files',
  filters: () => ({
    'Text files': getFilterExtensions('context'),
  }),
});

const selectMediaFiles = createMultiPicker({
  openLabel: 'Select Media',
  filters: () => ({
    'Image files': getFilterExtensions('media'),
    'Audio files': getFilterExtensions('audio'),
  }),
});

const selectOutputFiles = createMultiPicker({
  openLabel: 'Select Output Files',
  filters: () => ({ 'Text files': ['tex', 'txt', 'md'] }),
});

const selectEditedFile = (currentFile?: string) =>
  announceSelection(
    async () =>
      (
        await selectFiles({
          currentFile,
          openLabel: 'Select Edited File',
          filters: {},
        })
      )?.[0] ?? null,
  );

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
