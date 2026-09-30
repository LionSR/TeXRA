// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { getHelperModelName, type SessionHandle } from '@agent/runtime';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';

const CHANNEL = 'MergeCommands';

/** Merge `editedFile` into `baseFile`: the merge agent, launched through `texra.execute`. */
export const handleMerge = Effect.fn('mergeCommands.handleMerge')(function* (
  session: SessionHandle,
  baseFile: string,
  editedFile: string,
) {
  if (!baseFile || !editedFile) {
    yield* showLoggedMessageWithDocs(
      CHANNEL,
      'Both base file and edited file must be specified for merge operation',
      'intelligent-merge',
      'View Merge Docs',
    );
    return;
  }

  const model = yield* getHelperModelName(session.roots);
  yield* Effect.promise(() =>
    vscode.commands.executeCommand('texra.execute', {
      agent: 'merge',
      model,
      inputFiles: [baseFile],
      editedFile,
    }),
  );
});
