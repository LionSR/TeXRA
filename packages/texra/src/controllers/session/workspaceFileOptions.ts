/**
 * The workspace file listings both GUI hosts share: the launcher's file
 * catalogs of one workspace (`HostSnapshot.fileOptions`), the base
 * candidates from the input rules and the edited candidates from the edited
 * rules, and the label search over the input and context files. Each is
 * listed by one shared walk (`listWorkspaceFiles`), so both hosts list the
 * same files for the same folder.
 */
import { Effect } from 'effect';

import { WorkspaceFs } from '@texra-ai/harness/host';
import { openFirstLabelMatch } from '@latex/labelSearch';
import {
  getEditedFileListConfig,
  getFileListConfig,
} from '@texra/common/files/fileListingRules';
import { listWorkspaceFiles } from '@texra/common/files/workspaceFileListing';

/**
 * Reveal the first input or context file of the workspace that defines
 * `\label{label}` (`openFirstLabelMatch`), read through the session's
 * workspace view; `open` is the host's verb, given the match's absolute path
 * and character offset. `false` when no file defines it or no workspace is
 * open.
 */
export const findLabelInWorkspace = Effect.fn(
  'workspaceFileOptions.findLabelInWorkspace',
)(function* <OpenError>(
  workspacePath: string | undefined,
  label: string,
  open: (
    absolutePath: string,
    index: number,
  ) => Effect.Effect<unknown, OpenError>,
) {
  if (!workspacePath) return false;
  const [inputs, contexts] = yield* listWorkspaceFiles({
    root: workspacePath,
    configs: [getFileListConfig('input'), getFileListConfig('context')],
  });
  const workspaceFs = yield* WorkspaceFs;
  return yield* openFirstLabelMatch(
    label,
    new Set([...inputs, ...contexts]),
    (file) => workspaceFs.readFileString(file),
    (file, index) =>
      workspaceFs
        .resolve(file)
        .pipe(Effect.flatMap((absolutePath) => open(absolutePath, index))),
  );
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
