// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import {
  announce,
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { fileOpResultMessage, packRunOutputs } from '@housekeeping/runDirOps';
import { filesystemFor } from '@housekeeping/utils';
import { WorkspaceFs } from '@platform/rootedFs';
import { type FileOpResult } from '@shared/schemas';
import type { WorkflowFileOperationRequest } from '@texra/controllers/session/hostRunActions';

const CHANNEL = 'packCommands';

/** `folderPath` is the packed folder's absolute path: resolved by the
 *  session's workspace view, or where it is for an external selection. */
const showPackResult = (
  result: FileOpResult,
  inputFile: string,
  folderPath: string | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { level, text } = fileOpResultMessage('pack', result, inputFile);
    if (result.status === 'success' && folderPath) {
      yield* Effect.forkDetach(
        Effect.gen(function* () {
          const sel = yield* announce(
            CHANNEL,
            vscodeUi.info(text, { items: ['Open Folder'] }),
            undefined,
          );
          if (sel !== 'Open Folder') return;
          yield* safeExecuteCommand(
            'revealFileInOS',
            [vscode.Uri.file(folderPath)],
            CHANNEL,
          );
        }),
      );
    } else if (result.status === 'missingParams' || level === 'error') {
      yield* Effect.forkDetach(showLoggedMessage(CHANNEL, text));
    } else {
      yield* Effect.forkDetach(showLoggedInfoMessage(CHANNEL, text));
    }
  });

export const handlePack = Effect.fn('packCommands.handlePack')(function* (
  config: WorkflowFileOperationRequest,
) {
  const workspaceFs = yield* WorkspaceFs;
  const result = yield* packRunOutputs(config);

  const folder = result.status === 'success' ? result.outputFolder : undefined;
  const folderPath = folder
    ? (yield* filesystemFor(workspaceFs, folder)).absolutePath
    : undefined;
  yield* showPackResult(result, config.inputFile, folderPath);
});
