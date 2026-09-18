import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect, FileSystem, type PlatformError } from 'effect';

import {
  getFileListConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { attachDroppedPaths } from '@controllers/mainView/MainViewDroppedFilesController';
import { workspaceFileOptions } from '@controllers/session/workspaceFileOptions';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import type { DocumentFileType, FileOptions } from '@shared/schemas';
import { Rejected } from '@shared/session/requestErrors';
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
  pickFiles(
    fileType: ListableFileType,
    currentFile?: string | null,
  ): Promise<string[] | null>;
  /**
   * Paths dropped onto the launcher: the regular files inside the paper
   * whose extension the target category admits, workspace-relative. The
   * same plan the extension applies; a drop that attaches nothing fails with
   * the `Rejected` the request answers the surface with.
   */
  attachDroppedFiles(
    paths: readonly string[],
    category: DocumentFileType,
  ): Effect.Effect<
    string[],
    PlatformError.PlatformError | Rejected,
    FileSystem.FileSystem
  >;
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
    attachDroppedFiles(paths, category) {
      const probed: Effect.Effect<
        Array<string | null>,
        PlatformError.PlatformError,
        FileSystem.FileSystem
      > = workspacePath
        ? Effect.forEach(
            paths,
            (raw) => droppedWorkspaceFile(workspacePath, raw),
            { concurrency: 'unbounded' },
          )
        : Effect.succeed(paths.map(() => null));
      return Effect.flatMap(probed, (resolved) =>
        // The plan signals "nothing was attached" by throwing the `Rejected`
        // the request answers with, so that refusal belongs on the failure
        // channel; anything else it could throw stays a defect, as it was
        // when this member answered with a promise.
        Effect.try({
          try: () =>
            attachDroppedPaths(resolved, getIncludedExtensions(category)).paths,
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            cause instanceof Rejected ? Effect.fail(cause) : Effect.die(cause),
          ),
        ),
      );
    },
  };
}
