import { resolve } from 'node:path';

import { Effect, FileSystem, type PlatformError } from 'effect';

import { relativeToRoot } from '@texra-ai/harness/node';
import type { FileOptions } from '@shared/schemas';
import {
  getFileListConfig,
  type ListableFileType,
} from '@texra/common/files/fileListingRules';
import { workspaceFileOptions } from '@texra/controllers/session/workspaceFileOptions';
import { normalizeFilePath } from '@utils/core';

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
  ): Promise<string[] | undefined>;
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
   * The native picker for one multi-file list. Resolves to the chosen
   * files, workspace-relative where they are inside the paper, or null when
   * the dialog was cancelled.
   */
  pickFiles(fileType: ListableFileType): Promise<string[] | null>;
}

const DIALOG_TITLE_BY_FILE_TYPE: Record<ListableFileType, string> = {
  input: 'Select input files',
  context: 'Select context files',
  media: 'Select media files',
};

function toWorkspaceRelative(workspacePath: string, filePath: string): string {
  const absolutePath = resolve(workspacePath, filePath);
  // relativeToRoot shares the canonicalize-then-compare fallback
  // `workspaceRelativePath` uses, so a native dialog pick that
  // resolves through a symlink (e.g. a symlinked folder inside the workspace)
  // lands workspace-relative here too. Unlike that identity fallback, an
  // outside-workspace pick stays an explicit normalized absolute path: the
  // renderer must be able to open a file chosen outside the workspace.
  return (
    relativeToRoot(workspacePath, absolutePath) ??
    normalizeFilePath(absolutePath)
  );
}

export function createDesktopFileSelection(
  options: DesktopFileSelectionOptions,
): DesktopFileSelection {
  const { workspacePath } = options;
  return {
    fileOptions: () => workspaceFileOptions(workspacePath),
    async pickFiles(fileType) {
      if (!workspacePath) return null;
      const listConfig = getFileListConfig(fileType);
      const selectedFiles = await options.showOpenFileDialog({
        title: DIALOG_TITLE_BY_FILE_TYPE[fileType],
        defaultPath: workspacePath,
        allowMultiple: true,
        filters: [
          {
            name: 'Supported files',
            // Electron's dialog filter extensions must not include the
            // leading dot (unlike getFileListConfig's `.tex`-style entries).
            extensions: listConfig.include.map((ext) => ext.replace(/^\./, '')),
          },
        ],
      });
      if (!selectedFiles) return null;
      return selectedFiles.map((file) =>
        toWorkspaceRelative(workspacePath, file),
      );
    },
  };
}
