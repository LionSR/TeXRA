// Third-party imports
import { Effect } from 'effect';

// Local imports
import { getHelperModelName, type SessionHandle } from '@agent/runtime';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';

const CHANNEL = 'MergeCommands';

/** Merge `editedFile` into `baseFile`: the merge agent's document task,
 *  launched through `texra.execute`. */
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
  yield* safeExecuteCommand(
    'texra.execute',
    [
      documentTaskConfig({
        agent: 'merge',
        model,
        inputFiles: [baseFile],
        editedFile,
      }),
    ],
    CHANNEL,
  );
});
