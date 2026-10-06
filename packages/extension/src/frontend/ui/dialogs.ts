// Third-party imports
import { Data, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports - utilities
import { ownedPrompt } from '@frontend/hosts/VscodeUiHost';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { workspaceRelativePath } from '@utils/files/workspaceFS';

const CHANNEL = 'dialogs';

/**
 * VS Code would not show its open dialog: `showOpenDialog` rejects only when
 * the host's own dialog machinery faults, which is the one failure either
 * picker below can raise. `member` names which picker asked.
 */
export class OpenDialogFailed extends Data.TaggedError('OpenDialogFailed')<{
  readonly member: 'selectFiles' | 'selectFolder';
  readonly message: string;
  readonly cause: unknown;
}> {}

/** VS Code would not show a quick pick or input box. */
export class HostPromptFailed extends Data.TaggedError('HostPromptFailed')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const hostPromptFailed = (cause: unknown) =>
  new HostPromptFailed({ message: toErrorMessage(cause), cause });

export function quickPick<T extends string | vscode.QuickPickItem>(
  items: readonly T[],
  options: vscode.QuickPickOptions,
): Effect.Effect<T | undefined, HostPromptFailed> {
  return ownedPrompt(
    async (token) =>
      (await vscode.window.showQuickPick(
        items as readonly vscode.QuickPickItem[],
        options,
        token,
      )) as T | undefined,
    hostPromptFailed,
  );
}

export function inputBox(
  options: vscode.InputBoxOptions,
): Effect.Effect<string | undefined, HostPromptFailed> {
  return ownedPrompt(
    (token) => vscode.window.showInputBox(options, token),
    hostPromptFailed,
  );
}

interface FileDialogOptions {
  /** Label for the open button */
  openLabel: string;
  /** Mapping from filter name to array of extensions without dots */
  filters: { [name: string]: string[] };
  /** The workspace root the dialog opens in and relativizes picks against. */
  workspacePath: string | undefined;
}

/**
 * Show a multi-select open file dialog in the workspace and return the
 * selected workspace-relative paths.
 */
export function selectFiles(
  options: FileDialogOptions,
): Effect.Effect<string[] | null, OpenDialogFailed> {
  return Effect.gen(function* () {
    const { workspacePath } = options;
    if (!workspacePath) {
      // The notice is detached, as the caller's `runFork` left it: the picker
      // answers "nothing picked" straight away rather than waiting on a toast
      // the user may never dismiss.
      yield* Effect.forkDetach(
        showLoggedMessage(CHANNEL, 'No workspace folder open'),
      );
      return null;
    }

    const fileUris = yield* Effect.tryPromise({
      try: async () =>
        vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: options.openLabel,
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: vscode.Uri.file(workspacePath),
          filters: options.filters,
        }),
      catch: (cause) =>
        new OpenDialogFailed({
          member: 'selectFiles',
          message: toErrorMessage(cause),
          cause,
        }),
    });

    if (!fileUris?.length) {
      return null;
    }
    return fileUris.map((uri) =>
      workspaceRelativePath(workspacePath, uri.fsPath),
    );
  });
}

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
): Effect.Effect<string | null, OpenDialogFailed> {
  return Effect.tryPromise({
    try: async () =>
      vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: options.openLabel,
        title: options.title,
      }),
    catch: (cause) =>
      new OpenDialogFailed({
        member: 'selectFolder',
        message: toErrorMessage(cause),
        cause,
      }),
  }).pipe(Effect.map((folders) => folders?.[0]?.fsPath ?? null));
}
