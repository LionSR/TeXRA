// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getFilterExtensions } from '@common/files/fileTypeUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { selectFiles } from '@frontend/ui/dialogs';
import { createLog } from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';

const CHANNEL = 'fileSelectionCommands';
const log = createLog(CHANNEL);

interface PickerOptions {
  openLabel: string;
  filters: () => { [name: string]: string[] };
}

/** Run a dialog, announce what was picked, and report failures once. */
async function announceSelection(
  select: () => Promise<string[] | null>,
): Promise<string[] | null> {
  try {
    const result = await select();
    if (!result) {
      return null;
    }

    const message = `Selected files: ${result.join(', ')}`;
    vscode.window.showInformationMessage(message);
    log.info(message);
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

export const selectInputFiles = createMultiPicker({
  openLabel: 'Select Files',
  filters: () => ({
    'Text files': getFilterExtensions('input'),
  }),
});

export const selectContextFiles = createMultiPicker({
  openLabel: 'Select Context Files',
  filters: () => ({
    'Text files': getFilterExtensions('context'),
  }),
});

export const selectMediaFiles = createMultiPicker({
  openLabel: 'Select Media',
  filters: () => ({
    'Image files': getFilterExtensions('media'),
    'Audio files': getFilterExtensions('audio'),
  }),
});

export const selectOutputFiles = createMultiPicker({
  openLabel: 'Select Output Files',
  filters: () => ({ 'Text files': ['tex', 'txt', 'md'] }),
});

export async function getCurrentFile(): Promise<string | null> {
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
