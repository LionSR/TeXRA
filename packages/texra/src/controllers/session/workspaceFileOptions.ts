/**
 * The launcher's file catalogs of one workspace (PRD one-fold-three-renderers,
 * 8.1, `HostSnapshot.fileOptions`): the base candidates from the input rules
 * and the edited candidates from the edited rules, listed through the
 * `FileSystem` service from context, so both hosts list the same files for
 * the same folder.
 */
import { Effect } from 'effect';

import {
  getEditedFileListConfig,
  getFileListConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';

/**
 * List the workspace files of one listable type under the product's
 * file-listing rules. Empty when no workspace is open.
 */
export const listWorkspaceFilesOfType = Effect.fn(
  'workspaceFileOptions.listWorkspaceFilesOfType',
)(function* (
  fileType: ListableFileType,
  // Not a default parameter: callers inject a getter that returns undefined
  // to mean "no workspace", and a default would discard that and re-read
  // the process-wide workspace instead.
  workspacePath: string | undefined,
) {
  if (!workspacePath) return [];
  return yield* listWorkspaceFiles({
    root: workspacePath,
    config: getFileListConfig(fileType),
  });
});

/** The single-slot catalogs: base candidates are the input list; edited
 *  candidates are every file the edited rules admit, and the sheet narrows
 *  them to the chosen base. */
export const workspaceFileOptions = Effect.fn(
  'workspaceFileOptions.workspaceFileOptions',
)(function* (workspacePath: string | undefined) {
  if (!workspacePath) {
    return { baseFile: [], editedFile: [], commit: ['HEAD'] };
  }
  const [baseFile, editedFile] = yield* Effect.all(
    [
      listWorkspaceFilesOfType('input', workspacePath),
      listWorkspaceFiles({
        root: workspacePath,
        config: getEditedFileListConfig(),
      }),
    ],
    { concurrency: 'unbounded' },
  );
  return { baseFile, editedFile, commit: ['HEAD'] };
});
