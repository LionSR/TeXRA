// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { getFilterExtensions } from '@common/files/fileTypeUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { selectFiles } from '@frontend/ui/dialogs';
import { withLogChannel } from '@logger/effectLog';
import type { MultipleDocumentFileType } from '@shared/schemas';
import { workspaceRelativePath } from '@utils/files/workspaceFS';

const CHANNEL = 'fileSelectionCommands';

interface PickerOptions {
  openLabel: string;
  filters: () => { [name: string]: string[] };
}

/** Run a dialog, announce what was picked, and report failures once. */
function announceSelection<E>(
  select: Effect.Effect<string[] | null, E>,
): Effect.Effect<string[] | null> {
  return select.pipe(
    Effect.flatMap((result) => {
      if (!result) {
        return Effect.succeed(null);
      }

      const message = `Selected files: ${result.join(', ')}`;
      vscode.window.showInformationMessage(message);
      return Effect.logInfo(message).pipe(
        withLogChannel(CHANNEL),
        Effect.as(result),
      );
    }),
    Effect.catch((err) =>
      showLoggedErrorMessage(
        CHANNEL,
        'File selection failed. See the TeXRA log for details.',
        err,
      ).pipe(Effect.as(null)),
    ),
  );
}

function createMultiPicker(
  session: SessionHandle,
  options: PickerOptions,
): (currentFile?: string) => Effect.Effect<string[] | null> {
  return (currentFile) =>
    announceSelection(
      selectFiles({
        currentFile,
        workspacePath: session.roots.workspace,
        openLabel: options.openLabel,
        filters: options.filters(),
        allowMany: true,
      }),
    );
}

/**
 * The native picker of each multi-file launcher list, bound to the host's
 * session so the dialog's starting folder is that session's workspace.
 */
export function createFileSelectionPickers(
  session: SessionHandle,
): Record<
  MultipleDocumentFileType,
  (currentFile?: string) => Effect.Effect<string[] | null>
> {
  return {
    input: createMultiPicker(session, {
      openLabel: 'Select Files',
      filters: () => ({
        'Text files': getFilterExtensions('input'),
      }),
    }),
    context: createMultiPicker(session, {
      openLabel: 'Select Context Files',
      filters: () => ({
        'Text files': getFilterExtensions('context'),
      }),
    }),
    media: createMultiPicker(session, {
      openLabel: 'Select Media',
      filters: () => ({
        'Image files': getFilterExtensions('media'),
      }),
    }),
    output: createMultiPicker(session, {
      openLabel: 'Select Output Files',
      filters: () => ({ 'Text files': ['tex', 'txt', 'md'] }),
    }),
  };
}

export function getCurrentFile(
  session: SessionHandle,
): Effect.Effect<string | null> {
  return Effect.sync(() => {
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
  });
}
