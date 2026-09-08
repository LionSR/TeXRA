/**
 * The launcher's file catalogs of one workspace (PRD one-fold-three-renderers,
 * 8.1, `HostSnapshot.fileOptions`): the base candidates from the input rules
 * and the edited candidates from the edited rules, listed with the user's
 * file-list settings through the platform's directory reader, so both hosts
 * list the same files for the same folder.
 */
import { Effect } from 'effect';

import {
  getEditedFileListConfig,
  getFileListConfig,
  loadFileListSettings,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import type { FileOptions } from '@shared/schemas';
import type { PlatformError } from 'effect/PlatformError';
import type * as FileSystem from 'effect/FileSystem';

/**
 * List the workspace files of one listable type under the current file-list
 * settings. Empty when no workspace is open.
 */
export function listWorkspaceFilesOfType(
  fileType: ListableFileType,
  // Not a default parameter: callers inject a getter that returns undefined
  // to mean "no workspace", and a default would discard that and re-read
  // the process-wide workspace instead.
  workspacePath: string | undefined,
): Effect.Effect<string[], PlatformError, FileSystem.FileSystem> {
  if (!workspacePath) return Effect.succeed([]);
  return listWorkspaceFiles({
    root: workspacePath,
    config: getFileListConfig(fileType, loadFileListSettings()),
  });
}

/** The single-slot catalogs: base candidates are the input list; edited
 *  candidates are every file the edited rules admit, and the sheet narrows
 *  them to the chosen base. */
export function workspaceFileOptions(
  workspacePath: string | undefined,
): Effect.Effect<FileOptions, PlatformError, FileSystem.FileSystem> {
  if (!workspacePath) {
    return Effect.succeed({ baseFile: [], editedFile: [], commit: ['HEAD'] });
  }
  return Effect.map(
    Effect.all(
      [
        listWorkspaceFilesOfType('input', workspacePath),
        listWorkspaceFiles({
          root: workspacePath,
          config: getEditedFileListConfig(loadFileListSettings()),
        }),
      ],
      { concurrency: 2 },
    ),
    ([baseFile, editedFile]) => ({ baseFile, editedFile, commit: ['HEAD'] }),
  );
}
