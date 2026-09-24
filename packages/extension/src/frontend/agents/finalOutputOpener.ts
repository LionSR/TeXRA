import * as vscode from 'vscode';
import { Effect, Result } from 'effect';

import {
  selectAutoOpenFinalOutput,
  type WorkflowFlowResult,
} from '@agent/runtime';
import { withLogChannel } from '@logger/effectLog';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { ensureError } from '@utils/errors/errorMessage';

const CHANNEL = 'FinalOutputOpener';

/**
 * On successful workflow completion, preview the final revised output so
 * users don't feel the file "vanished" into run storage. A dismissible
 * status-bar hint reminds users that workflow mode is slow by design.
 *
 * The gate, outcome check, and which output counts as final live in
 * {@link selectAutoOpenFinalOutput} (shared with the desktop host); this only
 * supplies the VS Code open verb and status-bar hint.
 */
export const openFinalOutputIfAvailable = (
  stores: SettingsStores,
  result: WorkflowFlowResult,
) =>
  Effect.gen(function* () {
    const primary = yield* selectAutoOpenFinalOutput(stores, result);
    if (!primary) return;

    const previewed = yield* Effect.result(
      Effect.tryPromise({
        try: async () => {
          await vscode.window.showTextDocument(
            vscode.Uri.file(primary.absolutePath),
            {
              preview: true,
              preserveFocus: false,
            },
          );
          vscode.window.setStatusBarMessage(
            'Workflow complete — revised file opened in preview. Use the progress toolbar to Accept or Pack.',
            8000,
          );
        },
        catch: ensureError,
      }),
    );
    // The preview is the whole point of this call: a failure leaves the user
    // with only the status-bar hint, so it is loud, not a debug note.
    if (Result.isFailure(previewed))
      yield* Effect.logWarning(
        `Unable to auto-open final output ${primary.absolutePath}: ${String(previewed.failure)}`,
      ).pipe(withLogChannel(CHANNEL));
  });
