// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { packRunOutputs } from '@housekeeping/runDirOps';
import { filesystemFor } from '@housekeeping/utils';
import { WorkspaceFs } from '@platform/rootedFs';
import { type FileOpResult } from '@shared/schemas';
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
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const sel = yield* Effect.promise(() =>
              vscode.window.showInformationMessage(
                `Files packed into ${folder}`,
                'Open Folder',
              ),
            );
            if (sel !== 'Open Folder') return;
            yield* Effect.promise(() =>
              vscode.commands.executeCommand(
                'revealFileInOS',
                vscode.Uri.file(folderPath),
              ),
            );
          }),
        );
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
  const workspaceFs = yield* WorkspaceFs;
  const result = yield* packRunOutputs(config);

  const folder = result.status === 'success' ? result.outputFolder : undefined;
  const folderPath = folder
    ? (yield* filesystemFor(workspaceFs, folder)).absolutePath
    : undefined;
  yield* showPackResult(result, config.inputFile, folderPath);
});
