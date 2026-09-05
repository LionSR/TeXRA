import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getFileListConfig,
  loadFileListSettings,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import {
  attachedDroppedPaths,
  planMainViewDroppedFileAttachments,
} from '@controllers/mainView/MainViewDroppedFilesController';
import {
  listWorkspaceFilesOfType,
  workspaceFileOptions,
} from '@controllers/session/workspaceFileOptions';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import type { DocumentFileType, FileOptions } from '@shared/schemas';
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
 * catalogs (PRD 8.1) and the `pickFiles` and `attachDroppedFiles` arms of
 * `host.request` (8.3).
 */
export interface DesktopFileSelection {
  /** The launcher's single-slot catalogs: base candidates, edited
   *  candidates, and the commit list's fixed head. */
  fileOptions(): Promise<FileOptions>;
  /** Whether the paper has any input file at all (the empty-workspace cue). */
  hasInputFiles(): Promise<boolean>;
  /**
   * The native picker for one multi-file list. Resolves to the chosen
   * files, workspace-relative where they are inside the paper, or null when
   * the dialog was cancelled.
   */
  pickFiles(
    fileType: ListableFileType,
    currentFile?: string | null,
  ): Promise<string[] | null>;
  /**
   * Paths dropped onto the launcher: the regular files inside the paper
   * whose extension the target category admits, workspace-relative. The
   * same plan the extension applies; a drop that attaches nothing rejects.
   */
  attachDroppedFiles(
    paths: readonly string[],
    category: DocumentFileType,
  ): Promise<string[]>;
}

const DIALOG_TITLE_BY_FILE_TYPE: Record<ListableFileType, string> = {
  input: 'Select input files',
  context: 'Select context files',
  media: 'Select media files',
};

function toWorkspaceRelative(workspacePath: string, filePath: string): string {
  const absolutePath = resolve(workspacePath, filePath);
  // relativeToRoot shares the canonicalize-then-compare fallback
  // WorkspaceFS.relativePath uses, so a native dialog pick that
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
    async hasInputFiles() {
      return (
        (await listWorkspaceFilesOfType('input', workspacePath)).length > 0
      );
    },
    async pickFiles(fileType, currentFile) {
      if (!workspacePath) return null;
      const listConfig = getFileListConfig(fileType, loadFileListSettings());
      const defaultPath =
        currentFile == null
          ? workspacePath
          : resolve(workspacePath, currentFile);
      const selectedFiles = await options.showOpenFileDialog({
        title: DIALOG_TITLE_BY_FILE_TYPE[fileType],
        defaultPath,
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
    async attachDroppedFiles(paths, category) {
      const resolved = await Promise.all(
        paths.map(async (raw): Promise<string | null> => {
          if (!workspacePath) return null;
          const dropped = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
          const relative = relativeToRoot(workspacePath, dropped);
          if (relative === undefined) return null;
          const info = await stat(resolve(workspacePath, relative)).catch(
            () => null,
          );
          return info?.isFile() ? relative : null;
        }),
      );
      return attachedDroppedPaths(
        planMainViewDroppedFileAttachments({
          paths: resolved,
          allowedExtensions: {
            input: getIncludedExtensions('input'),
            context: getIncludedExtensions('context'),
            media: getIncludedExtensions('media'),
          },
          target: category,
        }),
      );
    },
  };
}
