/**
 * The workspace file listings both GUI hosts share: the input files of one
 * workspace, and the label search over the input and context files. Each is
 * listed by one shared walk (`listWorkspaceFiles`), so both hosts list the
 * same files for the same folder.
 */
import { Effect } from 'effect';

import { readNormalizedFile } from '@texra-ai/worldline/node';
import { WorkspaceFs } from '@texra-ai/worldline/plugins';
import { openFirstLabelMatch } from '@latex/labelSearch';
import { getFileListConfig } from '@texra/common/files/fileListingRules';
import { listWorkspaceFiles } from '@texra/common/files/workspaceFileListing';

/**
 * Reveal the first input or context file of the workspace that defines
 * `\label{label}` (`openFirstLabelMatch`), read through the session's
 * workspace view; `open` is the host's verb, given the match's absolute path
 * and 1-based line. `false` when no file defines it or no workspace is
 * open.
 */
export const findLabelInWorkspace = Effect.fn(
  'workspaceFileOptions.findLabelInWorkspace',
)(function* <OpenError, OpenServices>(
  workspaceRoot: string | undefined,
  label: string,
  open: (
    absolutePath: string,
    line: number,
  ) => Effect.Effect<unknown, OpenError, OpenServices>,
) {
  if (!workspaceRoot) return false;
  const [inputs, contexts] = yield* listWorkspaceFiles({
    root: workspaceRoot,
    configs: [getFileListConfig('input'), getFileListConfig('context')],
    links: 'follow',
  });
  const workspaceFs = yield* WorkspaceFs;
  return yield* openFirstLabelMatch(
    label,
    new Set([...inputs.files, ...contexts.files]),
    (file) => readNormalizedFile(workspaceFs, file),
    (file, line) =>
      workspaceFs
        .resolve(file)
        .pipe(Effect.flatMap((absolutePath) => open(absolutePath, line))),
  );
});

/** The files of the workspace a program can take as input. */
export const workspaceInputFiles = Effect.fn(
  'workspaceFileOptions.workspaceInputFiles',
)(function* (workspaceRoot: string | undefined) {
  if (!workspaceRoot) return [];
  const [inputs] = yield* listWorkspaceFiles({
    root: workspaceRoot,
    configs: [getFileListConfig('input')],
    links: 'follow',
  });
  return inputs.files;
});
