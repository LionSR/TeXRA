// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { getHelperModelName, type SessionHandle } from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';
import type { ProcessRuntime } from '@platform/processRuntime';

const CHANNEL = 'MergeCommands';

export function registerMergeCommands(
  context: vscode.ExtensionContext,
  runtime: ProcessRuntime,
  session: SessionHandle,
): void {
  registerCommandEntries(context, [
    {
      id: 'texra.merge',
      // The registered command is the host entry, so it owns the one run.
      handler: (baseFile: string, editedFile: string) =>
        runtime.runPromise(
          Effect.gen(function* () {
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
          }),
        ),
    },
  ]);
}
