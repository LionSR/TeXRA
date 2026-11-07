import { resolve } from 'node:path';

import { Effect, FileSystem, type Path, type PlatformError } from 'effect';
import { workspaceRelativePath } from '@texra-ai/harness/node';

import type { FileOptions } from '@texra/shared/session/hostSnapshot';
import type { ListableFileType } from '@texra/common/files/fileListingRules';
import { getFilterExtensions } from '@texra/common/files/fileTypeUtils';
import { workspaceFileOptions } from '@texra/controllers/session/workspaceFileOptions';

interface DesktopFileSelectionDialogOptions {
  title: string;
  defaultPath?: string;
  filters: Array<{ name: string; extensions: string[] }>;
  allowMultiple?: boolean;
}

interface DesktopFileSelectionOptions {
  /** The project's folder; undefined for the no-workspace session. */
  workspaceRoot: string | undefined;
  showOpenFileDialog(
    options: DesktopFileSelectionDialogOptions,
  ): Effect.Effect<string[] | undefined, Error>;
}

/**
 * The file lists and pickers of one project: the `host` snapshot's file
 * catalogs and the `pickFiles` arm of `host.request` (8.3).
 */
export interface DesktopFileSelection {
  /** The launcher's single-slot catalogs: base candidates, edited
   *  candidates, and the commit list's fixed head. */
  fileOptions(): Effect.Effect<
    FileOptions,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  >;
  /**
   * The native picker for one multi-file list. Succeeds with the chosen
   * files, workspace-relative where they are inside the project, or null when
   * the dialog was cancelled.
   */
  pickFiles(fileType: ListableFileType): Effect.Effect<string[] | null, Error>;
}

const DIALOG_TITLE_BY_FILE_TYPE: Record<ListableFileType, string> = {
  input: 'Select input files',
  context: 'Select context files',
  media: 'Select media files',
};

function toWorkspaceRelative(workspaceRoot: string, filePath: string): string {
  const absolutePath = resolve(workspaceRoot, filePath);
  // A pick that resolves through a symlink inside the workspace lands
  // workspace-relative; an outside-workspace pick stays a normalized
  // absolute path, so the renderer can still open it.
  return workspaceRelativePath(workspaceRoot, absolutePath);
}

export function createDesktopFileSelection(
  options: DesktopFileSelectionOptions,
): DesktopFileSelection {
  const { workspaceRoot } = options;
  return {
    fileOptions: () => workspaceFileOptions(workspaceRoot),
    pickFiles(fileType) {
      if (!workspaceRoot) return Effect.succeed(null);
      return options
        .showOpenFileDialog({
          title: DIALOG_TITLE_BY_FILE_TYPE[fileType],
          defaultPath: workspaceRoot,
          allowMultiple: true,
          filters: [
            {
              name: 'Supported files',
              extensions: getFilterExtensions(fileType),
            },
          ],
        })
        .pipe(
          Effect.map(
            (selectedFiles) =>
              selectedFiles?.map((file) =>
                toWorkspaceRelative(workspaceRoot, file),
              ) ?? null,
          ),
        );
    },
  };
}
