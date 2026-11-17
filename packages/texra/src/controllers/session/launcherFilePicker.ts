/**
 * The launcher's file picker, for both GUI hosts: what the dialog says and
 * filters by for each file list, and how the picks come back. A host
 * supplies only its native dialog that opens several files.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { workspaceRelativePath } from '@texra-ai/harness/node';
import { Rejected } from '@texra-ai/harness/schemas';
import { getFilterExtensions } from '@texra/common/files/fileTypeUtils';
import type { DocumentFileType } from '@texra/shared/launcher/fileTypes';
import {
  hostFailure,
  type HostCommandFailure,
} from '@texra/controllers/session/hostCallFailure';

/** A host's native dialog that opens several files: the absolute paths
 *  picked, or `undefined` when the person cancelled it. */
export type OpenFilesDialog = (options: {
  readonly title: string;
  /** The folder the dialog opens in. */
  readonly defaultPath: string;
  readonly filters: readonly {
    readonly name: string;
    readonly extensions: readonly string[];
  }[];
}) => Effect.Effect<readonly string[] | undefined, Error>;

const TITLE_BY_FILE_TYPE: Record<DocumentFileType, string> = {
  input: 'Select input files',
  context: 'Select context files',
  media: 'Select media files',
};

/**
 * The files picked for the launcher's `fileType` list, opened in the
 * workspace and filtered to the extensions that list takes. A pick inside
 * the workspace comes back workspace-relative and one outside it as its
 * absolute path. Null when nothing was picked. A window with no folder has
 * nothing to pick from, so the request is rejected with what to do, which
 * the view shows as it shows a dialog that failed.
 */
export function pickLauncherFiles(
  workspaceRoot: string | undefined,
  fileType: DocumentFileType,
  openFiles: OpenFilesDialog,
): Effect.Effect<readonly string[] | null, HostCommandFailure> {
  if (!workspaceRoot)
    return Effect.fail(
      new Rejected({ reason: 'Open a folder to pick files from it.' }),
    );
  return openFiles({
    title: TITLE_BY_FILE_TYPE[fileType],
    defaultPath: workspaceRoot,
    filters: [
      { name: 'Supported files', extensions: getFilterExtensions(fileType) },
    ],
  }).pipe(
    Effect.map((picked) =>
      picked?.length
        ? picked.map((file) => workspaceRelativePath(workspaceRoot, file))
        : null,
    ),
    Effect.mapError((cause) => hostFailure('pickFiles', cause)),
  );
}
