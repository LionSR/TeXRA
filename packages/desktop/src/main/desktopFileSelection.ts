import { resolve } from 'node:path';

import { Effect, FileSystem, type PlatformError } from 'effect';
import { workspaceRelativePath } from '@texra-ai/harness/node';

import type { FileOptions } from '@texra/shared/session/hostSnapshot';
import {
  getFileListConfig,
  type ListableFileType,
} from '@texra/common/files/fileListingRules';
import { workspaceFileOptions } from '@texra/controllers/session/workspaceFileOptions';

interface DesktopFileSelectionDialogOptions {
  title: string;
  defaultPath?: string;
  filters: Array<{ name: string; extensions: string[] }>;
  allowMultiple?: boolean;
}

interface DesktopFileSelectionOptions {
  /** The paper's folder; undefined for the no-workspace session. */
  workspacePath: string | undefined;
  showOpenFileDialog(
    options: DesktopFileSelectionDialogOptions,
  ): Effect.Effect<string[] | undefined, Error>;
}

/**
 * The file lists and pickers of one paper: the `host` snapshot's file
 * catalogs (PRD 8.1) and the `pickFiles` arm of `host.request` (8.3).
 */
export interface DesktopFileSelection {
  /** The launcher's single-slot catalogs: base candidates, edited
   *  candidates, and the commit list's fixed head. */
  fileOptions(): Effect.Effect<
    FileOptions,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  >;
  /**
   * The native picker for one multi-file list. Succeeds with the chosen
   * files, workspace-relative where they are inside the paper, or null when
   * the dialog was cancelled.
   */
  pickFiles(fileType: ListableFileType): Effect.Effect<string[] | null, Error>;
}

const DIALOG_TITLE_BY_FILE_TYPE: Record<ListableFileType, string> = {
  input: 'Select input files',
  context: 'Select context files',
  media: 'Select media files',
};

function toWorkspaceRelative(workspacePath: string, filePath: string): string {
  const absolutePath = resolve(workspacePath, filePath);
  // A pick that resolves through a symlink inside the workspace lands
  // workspace-relative; an outside-workspace pick stays a normalized
  // absolute path, so the renderer can still open it.
  return workspaceRelativePath(workspacePath, absolutePath);
}

export function createDesktopFileSelection(
  options: DesktopFileSelectionOptions,
): DesktopFileSelection {
  const { workspacePath } = options;
  return {
    fileOptions: () => workspaceFileOptions(workspacePath),
    pickFiles(fileType) {
      if (!workspacePath) return Effect.succeed(null);
      const listConfig = getFileListConfig(fileType);
      return options
        .showOpenFileDialog({
          title: DIALOG_TITLE_BY_FILE_TYPE[fileType],
          defaultPath: workspacePath,
          allowMultiple: true,
          filters: [
            {
              name: 'Supported files',
              // Electron's dialog filter extensions must not include the
              // leading dot (unlike getFileListConfig's `.tex`-style entries).
              extensions: listConfig.include.map((ext) =>
                ext.replace(/^\./, ''),
              ),
            },
          ],
        })
        .pipe(
          Effect.map(
            (selectedFiles) =>
              selectedFiles?.map((file) =>
                toWorkspaceRelative(workspacePath, file),
              ) ?? null,
          ),
        );
    },
  };
}
