// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { getFilterExtensions } from '@common/files/fileTypeUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { selectFiles } from '@frontend/ui/dialogs';
import { createLog } from '@logger/logUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { MultipleDocumentFileType } from '@shared/schemas';
import { workspaceRelativePath } from '@utils/files/workspaceFS';

const CHANNEL = 'fileSelectionCommands';
const log = createLog(CHANNEL);

interface PickerOptions {
  openLabel: string;
  filters: () => { [name: string]: string[] };
}

/** Run a dialog, announce what was picked, and report failures once. */
function announceSelection(
  select: () => Promise<string[] | null>,
  runtime: ProcessRuntime,
): Promise<string[] | null> {
  return runtime.runPromise(
    Effect.tryPromise({
      try: async () => {
        const result = await select();
        if (!result) {
          return null;
        }

        const message = `Selected files: ${result.join(', ')}`;
        vscode.window.showInformationMessage(message);
        log.info(message);
        return result;
      },
      catch: (err: unknown) => err,
    }).pipe(
      Effect.catch((err) =>
        showLoggedErrorMessage(
          CHANNEL,
          'File selection failed. See the TeXRA log for details.',
          err,
        ).pipe(Effect.as(null)),
      ),
    ),
  );
}

function createMultiPicker(
  session: SessionHandle,
  runtime: ProcessRuntime,
  options: PickerOptions,
): (currentFile?: string) => Promise<string[] | null> {
  return (currentFile) =>
    announceSelection(
      () =>
        selectFiles({
          currentFile,
          workspacePath: session.roots.workspace,
          openLabel: options.openLabel,
          filters: options.filters(),
          allowMany: true,
          runtime,
        }),
      runtime,
    );
}

/**
 * The native picker of each multi-file launcher list, bound to the host's
 * session so the dialog's starting folder is that session's workspace.
 */
export function createFileSelectionPickers(
  session: SessionHandle,
  runtime: ProcessRuntime,
): Record<
  MultipleDocumentFileType,
  (currentFile?: string) => Promise<string[] | null>
> {
  return {
    input: createMultiPicker(session, runtime, {
      openLabel: 'Select Files',
      filters: () => ({
        'Text files': getFilterExtensions('input'),
      }),
    }),
    context: createMultiPicker(session, runtime, {
      openLabel: 'Select Context Files',
      filters: () => ({
        'Text files': getFilterExtensions('context'),
      }),
    }),
    media: createMultiPicker(session, runtime, {
      openLabel: 'Select Media',
      filters: () => ({
        'Image files': getFilterExtensions('media'),
      }),
    }),
    output: createMultiPicker(session, runtime, {
      openLabel: 'Select Output Files',
      filters: () => ({ 'Text files': ['tex', 'txt', 'md'] }),
    }),
  };
}

export async function getCurrentFile(
  session: SessionHandle,
): Promise<string | null> {
  const workspaceRoot = session.roots.workspace;
  // Try activeTextEditor first (for text files)
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file') {
    return workspaceRelativePath(workspaceRoot, doc.uri.fsPath);
  }

  // Fallback to active tab (for media files like images, PDFs)
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const isFileInput =
    (input instanceof vscode.TabInputText ||
      input instanceof vscode.TabInputCustom) &&
    input.uri.scheme === 'file';

  return isFileInput
    ? workspaceRelativePath(workspaceRoot, input.uri.fsPath)
    : null;
}
