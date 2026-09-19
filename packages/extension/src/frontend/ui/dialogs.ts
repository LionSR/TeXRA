// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports - utilities
import { TeamCatalogPortFailed } from '@common/teams/TeamAvailabilityPreflight';
import type { TeamAvailabilityPrompt } from '@common/teams/TeamPlan';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { workspaceRelativePath } from '@utils/files/workspaceFS';

type TeamAvailabilityChoice =
  TeamAvailabilityPrompt['actions'][number]['choice'];

const CHANNEL = 'dialogs';

interface FileDialogOptions {
  /** Whether multiple files can be selected */
  allowMany?: boolean;
  /** Label for the open button */
  openLabel: string;
  /** Mapping from filter name to array of extensions without dots */
  filters: { [name: string]: string[] };
  /** Current file path relative to workspace (used to compute defaultUri) */
  currentFile?: string;
  /** The workspace root the dialog opens in and relativizes picks against. */
  workspacePath: string | undefined;
}

function computeDefaultUri({
  workspacePath,
  currentFile,
}: FileDialogOptions): vscode.Uri | null {
  if (!workspacePath) {
    return null;
  }
  const basePath = currentFile
    ? path.dirname(path.join(workspacePath, currentFile))
    : workspacePath;
  return vscode.Uri.file(basePath);
}

/**
 * Generic helper to show an open file dialog and return selected relative paths.
 */
export function selectFiles(
  options: FileDialogOptions,
): Effect.Effect<string[] | null, unknown> {
  return Effect.gen(function* () {
    const defaultUri = computeDefaultUri(options);
    if (!defaultUri) {
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
          canSelectMany: options.allowMany ?? false,
          openLabel: options.openLabel,
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri,
          filters: options.filters,
        }),
      catch: (cause: unknown) => cause,
    });

    if (!fileUris?.length) {
      return null;
    }
    return fileUris.map((uri) =>
      workspaceRelativePath(options.workspacePath, uri.fsPath),
    );
  });
}

/**
 * Show a `TeamAvailabilityPrompt` as a native VS Code warning and map the
 * clicked label back to its `choice`. `modal: true` (the settings flow) shows
 * one dialog button per action; `modal: false` (the launch flow) shows a
 * lighter non-modal notification with the same button labels. The VS Code
 * dialog is the team-availability `choose` port's own foreign edge, so it is
 * wrapped here once and raises the port's `TeamCatalogPortFailed`.
 */
export function chooseTeamAvailabilityViaDialog(
  prompt: TeamAvailabilityPrompt,
  options: { readonly modal: boolean },
): Effect.Effect<TeamAvailabilityChoice | undefined, TeamCatalogPortFailed> {
  return Effect.tryPromise({
    try: async () => {
      if (options.modal) {
        const items = prompt.actions.map((action) => ({
          title: action.label,
          isCloseAffordance: action.choice === 'cancel',
        }));
        const choice = await vscode.window.showWarningMessage(
          prompt.message,
          { modal: true },
          ...items,
        );
        return prompt.actions.find((action) => action.label === choice?.title)
          ?.choice;
      }
      const choice = await vscode.window.showWarningMessage(
        prompt.message,
        ...prompt.actions.map((action) => action.label),
      );
      return prompt.actions.find((action) => action.label === choice)?.choice;
    },
    catch: (cause) =>
      new TeamCatalogPortFailed({
        member: 'choose',
        message: `The host could not ask about the unavailable members: ${toErrorMessage(cause)}`,
        cause,
      }),
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
 * no workspace, so it's safe to call before a workspace (or `platform()`) is
 * available.
 */
export function selectFolder(
  options: FolderDialogOptions,
): Effect.Effect<string | null, unknown> {
  return Effect.tryPromise({
    try: async () =>
      vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: options.openLabel,
        title: options.title,
      }),
    catch: (cause: unknown) => cause,
  }).pipe(Effect.map((folders) => folders?.[0]?.fsPath ?? null));
}
