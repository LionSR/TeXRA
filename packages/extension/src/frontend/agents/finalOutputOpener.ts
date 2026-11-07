import * as vscode from 'vscode';
import { Effect, Result } from 'effect';

import { withLogChannel } from '@texra-ai/harness/host';
import { ensureError } from '@texra-ai/harness/schemas';

const CHANNEL = 'FinalOutputOpener';

/**
 * After a workflow completes, preview its final revised output (which one
 * is `selectAutoOpenFinalOutput`'s, in the shared run actions) so users
 * don't feel the file "vanished" into run storage. A dismissible status-bar
 * hint reminds users that workflow mode is slow by design. The preview is
 * the whole point of this call: a failure leaves the user with only the
 * hint, so it is loud, not a debug note.
 */
export const previewFinalOutput = (absolutePath: string) =>
  Effect.gen(function* () {
    const previewed = yield* Effect.result(
      Effect.tryPromise({
        try: async () => {
          await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), {
            preview: true,
            preserveFocus: false,
          });
          vscode.window.setStatusBarMessage(
            'Workflow complete — revised file opened in preview. Use the progress toolbar to Accept or Pack.',
            8000,
          );
        },
        catch: ensureError,
      }),
    );
    if (Result.isFailure(previewed))
      yield* Effect.logWarning(
        `Unable to auto-open final output ${absolutePath}: ${String(previewed.failure)}`,
      ).pipe(withLogChannel(CHANNEL));
  });
