/**
 * The launcher's file catalogs of one workspace (PRD one-fold-three-renderers,
 * 8.1, `HostSnapshot.fileOptions`): the base candidates from the input rules
 * and the edited candidates from the edited rules, listed by one shared
 * walk (`listWorkspaceFiles`), so both hosts list the same files for the same
 * folder.
 */
import { Effect } from 'effect';

import {
  getEditedFileListConfig,
  getFileListConfig,
  type ListableFileType,
} from '@texra/common/files/fileListingRules';
import { listWorkspaceFiles } from '@texra/common/files/workspaceFileListing';

/**
 * List the workspace files of each listable type under the product's
 * file-listing rules, in one walk: one list per type, in the order given.
 * Empty lists when no workspace is open.
 */
export const listWorkspaceFilesOfType = Effect.fn(
  'workspaceFileOptions.listWorkspaceFilesOfType',
)(function* (
  fileTypes: readonly ListableFileType[],
  // Not a default parameter: callers inject a getter that returns undefined
  // to mean "no workspace", and a default would discard that and re-read
  // the process-wide workspace instead.
  workspacePath: string | undefined,
) {
  if (!workspacePath) return fileTypes.map((): string[] => []);
  return yield* listWorkspaceFiles({
    root: workspacePath,
    configs: fileTypes.map(getFileListConfig),
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
  const [baseFile, editedFile] = yield* listWorkspaceFiles({
    root: workspacePath,
    configs: [getFileListConfig('input'), getEditedFileListConfig()],
  });
  return { baseFile, editedFile, commit: ['HEAD'] };
});
