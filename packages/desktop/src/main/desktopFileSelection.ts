import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect, FileSystem } from 'effect';

import {
  getFileListConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { attachDroppedPaths } from '@controllers/mainView/MainViewDroppedFilesController';
import { workspaceFileOptions } from '@controllers/session/workspaceFileOptions';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import type { ProcessRuntime } from '@platform/processRuntime';
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
  /** The process runtime the window was handed; the dropped-path probe
   *  below settles on it. */
  runtime: ProcessRuntime;
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

/**
 * One dropped path, answered with its workspace-relative name or `null` when
 * the launcher does not take it.
 *
 * A path outside the paper, and one that does not name a regular file, are
 * both dropped. So is one that is no longer there: a drag whose source moved
 * between the drop and this probe is the user's own race, and `NotFound` is
 * the only absence this treats as one. Every other stat failure — an
 * unreadable folder, a symlink loop — fails the whole drop instead of quietly
 * shrinking it, because a path discarded in silence looks to the user like a
 * file the launcher refused.
 */
const droppedWorkspaceFile = Effect.fn(
  'desktopFileSelection.droppedWorkspaceFile',
)(function* (workspacePath: string, raw: string) {
  const dropped = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
  const relative = relativeToRoot(workspacePath, dropped);
  if (relative === undefined) return null;
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(resolve(workspacePath, relative)).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === 'NotFound',
      () => Effect.succeed(undefined),
    ),
  );
  return info?.type === 'File' ? relative : null;
});

export function createDesktopFileSelection(
  options: DesktopFileSelectionOptions,
): DesktopFileSelection {
  const { workspacePath } = options;
  return {
    fileOptions: () => workspaceFileOptions(workspacePath),
    async pickFiles(fileType, currentFile) {
      if (!workspacePath) return null;
      const listConfig = getFileListConfig(fileType);
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
      const root = workspacePath;
      const resolved = root
        ? await options.runtime.runPromise(
            Effect.forEach(paths, (raw) => droppedWorkspaceFile(root, raw), {
              concurrency: 'unbounded',
            }),
          )
        : paths.map(() => null);
      return attachDroppedPaths(resolved, getIncludedExtensions(category))
        .paths;
    },
  };
}
