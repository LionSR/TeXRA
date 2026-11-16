// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports - utilities
import { workspaceRelativePath } from '@texra-ai/harness/node';
import { hostFailed } from '@texra/controllers/session/hostCallFailure';
import type { HostFailed } from '@texra/hosts/uiHosts';
import { withCancellationToken } from '@frontend/hosts/VscodeUiHost';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';

export function quickPick<T extends string | vscode.QuickPickItem>(
  items: readonly T[],
  options: vscode.QuickPickOptions,
): Effect.Effect<T | undefined, HostFailed> {
  // A string shows as an item with that label; the pick maps back to its entry.
  const entries = items.map((item) => {
    const shown: string | vscode.QuickPickItem = item;
    return {
      item,
      pick: typeof shown === 'string' ? { label: shown } : shown,
    };
  });
  return withCancellationToken(
    async (token) => {
      const picked = await vscode.window.showQuickPick(
        entries.map(({ pick }) => pick),
        options,
        token,
      );
      return entries.find(({ pick }) => pick === picked)?.item;
    },
    (cause) => hostFailed('quickPick', cause),
  );
}

export function inputBox(
  options: vscode.InputBoxOptions,
): Effect.Effect<string | undefined, HostFailed> {
  return withCancellationToken(
    (token) => vscode.window.showInputBox(options, token),
    (cause) => hostFailed('inputBox', cause),
  );
}

interface FileDialogOptions {
  /** Label for the open button */
  openLabel: string;
  /** Mapping from filter name to array of extensions without dots */
  filters: { [name: string]: string[] };
  /** The workspace root the dialog opens in and relativizes picks against. */
  workspaceRoot: string | undefined;
}

/**
 * Show a multi-select open file dialog in the workspace and return the
 * selected workspace-relative paths.
 */
export const selectFiles = Effect.fn('selectFiles')(function* (
  options: FileDialogOptions,
): Effect.fn.Return<string[] | null, HostFailed> {
  const { workspaceRoot } = options;
  if (!workspaceRoot) {
    // The notice is detached: the picker answers "nothing picked" straight
    // away rather than waiting on a toast the user may never dismiss.
    yield* showLoggedMessage('No workspace folder open');
    return null;
  }

  const fileUris = yield* Effect.tryPromise({
    try: async () =>
      vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: options.openLabel,
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: vscode.Uri.file(workspaceRoot),
        filters: options.filters,
      }),
    catch: (cause) => hostFailed('selectFiles', cause),
  });

  if (!fileUris?.length) {
    return null;
  }
  return fileUris.map((uri) =>
    workspaceRelativePath(workspaceRoot, uri.fsPath),
  );
});

interface FolderDialogOptions {
  /** Label for the open button */
  openLabel: string;
  /** Optional dialog title */
  title?: string;
}

/**
 * Generic helper to show a folder-picker dialog and return the selected
 * absolute path. Unlike {@link selectFiles}, this needs
 * no workspace, so it's safe to call before a workspace is available.
 */
export function selectFolder(
  options: FolderDialogOptions,
): Effect.Effect<string | null, HostFailed> {
  return Effect.tryPromise({
    try: async () =>
      vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: options.openLabel,
        title: options.title,
      }),
    catch: (cause) => hostFailed('selectFolder', cause),
  }).pipe(Effect.map((folders) => folders?.[0]?.fsPath ?? null));
}
