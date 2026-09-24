// Third-party imports
import { Cause, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';

const CHANNEL = 'mainViewCommands';

interface RefreshAllOptionsArgs {
  readonly selectedToolUseAgent?: string;
  readonly agentCatalogAlreadyFresh?: boolean;
}

/** Registers main view commands for the extension. */
export function registerMainViewCommands(
  context: vscode.ExtensionContext,
  progressViewProvider: ProgressViewProvider,
  runtime: ProcessRuntime,
): void {
  registerCommandEntries(context, [
    {
      id: 'texra.refreshAllOptions',
      handler: (args?: RefreshAllOptionsArgs) =>
        runtime.runPromise(
          progressViewProvider.refreshCatalogs(args ?? {}).pipe(
            // The command's one terminal boundary, as the rejection the
            // lift it replaces caught was: a failed catalog load and a
            // failed snapshot publish are reported alike.
            Effect.catchCause((cause) =>
              showLoggedErrorMessage(
                CHANNEL,
                'Failed to refresh options',
                Cause.squash(cause),
              ).pipe(Effect.asVoid),
            ),
          ),
        ),
    },
  ]);
}
