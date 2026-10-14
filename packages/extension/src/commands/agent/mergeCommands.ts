// Third-party imports
import { Effect } from 'effect';

// Local imports
import { getHelperModelName } from '@agent/runtime';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';
import type { WorkspaceRoots } from '@texra-ai/harness';

const CHANNEL = 'MergeCommands';

/** Merge `editedFile` into `baseFile`: the merge agent's document task,
 *  launched through `texra.execute`. */
export const handleMerge = Effect.fn('mergeCommands.handleMerge')(function* (
  roots: WorkspaceRoots,
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

  const model = yield* getHelperModelName(roots);
  // A launch that cannot be built (no catalog, no merge task) says why.
  const refuse = ({ message }: { readonly message: string }) =>
    showLoggedMessageWithDocs(
      CHANNEL,
      `Merge: ${message}`,
      'intelligent-merge',
      'View Merge Docs',
    ).pipe(Effect.as(null));
  const config = yield* documentTaskConfig(
    { agent: 'merge', model, inputFiles: [baseFile], editedFile },
    roots,
  ).pipe(
    Effect.catchTags({
      DocumentTaskRefused: refuse,
      AgentCatalogLoadError: refuse,
    }),
  );
  if (config === null) return;
  yield* safeExecuteCommand('texra.execute', [config], CHANNEL);
});
