// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { runPackSingle, runPackMultiple } from '@housekeeping/pack';
import { runPackRunDir } from '@housekeeping/runDirOps';
import { filesystemFor } from '@housekeeping/utils';
import { WorkspaceFs } from '@platform/rootedFs';

import {
  mergeRunDirAndWorkspaceResult,
  type FileOpResult,
} from '@shared/schemas';
import { type PackConfig } from './fileOpSchemas';

const CHANNEL = 'packCommands';

/** `folderPath` is the packed folder's absolute path: resolved by the
 *  session's workspace view, or where it is for an external selection. */
const showPackResult = (
  result: FileOpResult,
  inputFile: string,
  folderPath: string | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    switch (result.status) {
      case 'success': {
        const folder = result.outputFolder;
        if (!folder || !folderPath) return;
        vscode.window
          .showInformationMessage(`Files packed into ${folder}`, 'Open Folder')
          .then((sel) => {
            if (sel === 'Open Folder') {
              void vscode.commands.executeCommand(
                'revealFileInOS',
                vscode.Uri.file(folderPath),
              );
            }
          });
        break;
      }
      case 'noFiles':
        vscode.window.showInformationMessage(
          `No files found to pack for ${inputFile}`,
        );
        break;
      case 'missingParams':
        yield* Effect.forkDetach(
          showLoggedMessage(CHANNEL, 'Select an input file before packing.'),
        );
        break;
      case 'error':
        void vscode.window.showErrorMessage(
          `Error during packing: ${result.error}`,
        );
        break;
    }
  });

export const handlePack = Effect.fn('packCommands.handlePack')(function* (
  config: PackConfig,
) {
  const { agent, model, inputFile, outputFiles, runId } = config;
  const workspaceFs = yield* WorkspaceFs;
  const packWorkspace =
    outputFiles.length > 0
      ? runPackMultiple(model, inputFile, agent, outputFiles)
      : runPackSingle(model, inputFile, agent);

  // Toolbar invocations pass a runId: pack the run's storage AND the source
  // document's own files beside it in the workspace.
  const result: FileOpResult = runId
    ? mergeRunDirAndWorkspaceResult(
        yield* runPackRunDir(runId, agent, model, inputFile),
        yield* packWorkspace,
      )
    : yield* packWorkspace;

  const folder = result.status === 'success' ? result.outputFolder : undefined;
  const folderPath = folder
    ? (yield* filesystemFor(workspaceFs, folder)).absolutePath
    : undefined;
  yield* showPackResult(result, inputFile, folderPath);
});
