/**
 * The launcher's file catalogs of one workspace (PRD one-fold-three-renderers,
 * 8.1, `HostSnapshot.fileOptions`): the base candidates from the input rules
 * and the edited candidates from the edited rules, listed with the user's
 * file-list settings through the platform's directory reader, so both hosts
 * list the same files for the same folder.
 */
import {
  getEditedFileListConfig,
  getFileListConfig,
  loadFileListSettings,
  type FileFilterConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import { platform } from '@platform/platform';
import type { FileOptions } from '@shared/schemas';

function listFiles(root: string, config: FileFilterConfig): Promise<string[]> {
  return listWorkspaceFiles({
    root,
    config,
    readDirectory: (directory) => platform().fs.readDirectory(directory),
  });
}

/**
 * List the workspace files of one listable type under the current file-list
 * settings. Empty when no workspace is open.
 */
export async function listWorkspaceFilesOfType(
  fileType: ListableFileType,
  // Not a default parameter: callers inject a getter that returns undefined
  // to mean "no workspace", and a default would discard that and re-read
  // the process-wide workspace instead.
  workspacePath: string | undefined,
): Promise<string[]> {
  const config = getFileListConfig(fileType, loadFileListSettings());
  if (!workspacePath) return [];
  return listFiles(workspacePath, config);
}

/** The single-slot catalogs: base candidates are the input list; edited
 *  candidates are every file the edited rules admit, and the sheet narrows
 *  them to the chosen base. */
export async function workspaceFileOptions(
  workspacePath: string | undefined,
): Promise<FileOptions> {
  if (!workspacePath) return { baseFile: [], editedFile: [], commit: ['HEAD'] };
  const [baseFile, editedFile] = await Promise.all([
    listWorkspaceFilesOfType('input', workspacePath),
    listFiles(workspacePath, getEditedFileListConfig(loadFileListSettings())),
  ]);
  return { baseFile, editedFile, commit: ['HEAD'] };
}
