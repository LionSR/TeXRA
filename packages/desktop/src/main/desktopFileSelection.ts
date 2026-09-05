import { resolve } from 'node:path';

import {
  getEditedFileListConfig,
  getFileListConfig,
  loadFileListSettings,
  type FileFilterConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import { platform } from '@platform/platform';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import type { FileOptions } from '@shared/schemas';
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
  /** Paths dropped onto the launcher, made workspace-relative. */
  relativize(paths: readonly string[]): string[];
}

const DIALOG_TITLE_BY_FILE_TYPE: Record<ListableFileType, string> = {
  input: 'Select input files',
  context: 'Select context files',
  media: 'Select media files',
};

function listFiles(
  root: string,
  rawConfig: FileFilterConfig,
): Promise<string[]> {
  return listWorkspaceFiles({
    root,
    config: rawConfig,
    readDirectory: (directory) => platform().fs.readDirectory(directory),
  });
}

/**
 * List the workspace files of one listable type under the current file-list
 * settings. Empty when no workspace is open.
 */
export async function listDesktopWorkspaceFiles(
  fileType: ListableFileType,
  // Not a default parameter: callers inject a getter that returns undefined to
  // mean "no workspace", and a default would discard that and re-read the
  // process-wide workspace instead.
  workspacePath: string | undefined,
): Promise<string[]> {
  const config = getFileListConfig(fileType, loadFileListSettings());
  if (!workspacePath) return [];
  return listFiles(workspacePath, config);
}

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
  const list = (fileType: ListableFileType) =>
    listDesktopWorkspaceFiles(fileType, workspacePath);

  return {
    async fileOptions() {
      if (!workspacePath) {
        return { baseFile: [], editedFile: [], commit: ['HEAD'] };
      }
      // The base file is listed from the input rules: base is a single-slot
      // view over the input list. Edited candidates are every file the
      // edited rules admit; the sheet narrows them to the chosen base.
      const [baseFile, editedFile] = await Promise.all([
        list('input'),
        listFiles(
          workspacePath,
          getEditedFileListConfig(loadFileListSettings()),
        ),
      ]);
      return { baseFile, editedFile, commit: ['HEAD'] };
    },
    async hasInputFiles() {
      return (await list('input')).length > 0;
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
    relativize(paths) {
      if (!workspacePath) return paths.map((file) => normalizeFilePath(file));
      return paths.map((file) => toWorkspaceRelative(workspacePath, file));
    },
  };
}
