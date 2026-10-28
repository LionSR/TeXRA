// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { WorkspaceFs } from '@texra-ai/harness/host';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import {
  announce,
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { fileOpResultMessage } from '@housekeeping/runDirOps';
import { filesystemFor } from '@housekeeping/utils';
import type { WorkflowFileOperationResult } from '@texra/controllers/session/hostRunActions';

const CHANNEL = 'packCommands';

/** Tell the user what the toolbar's Pack did, offering its folder: the packed
 *  folder's absolute path, resolved by the session's workspace view, or where
 *  it is for an external selection. */
export const presentPack = Effect.fn('packCommands.presentPack')(function* ({
  result,
  inputFile,
}: WorkflowFileOperationResult) {
  const workspaceFs = yield* WorkspaceFs;
  const folder = result.status === 'success' ? result.outputFolder : undefined;
  const folderPath = folder
    ? (yield* filesystemFor(workspaceFs, folder)).absolutePath
    : undefined;
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
