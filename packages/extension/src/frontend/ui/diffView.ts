import { Effect, Stream } from 'effect';
import * as vscode from 'vscode';

import { logFailure, withLogChannel } from '@texra-ai/harness/plugins';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { eventStream } from '@frontend/vscode/vscodeEvents';

const CHANNEL = 'DiffView';

/** How long a burst of view-column changes must go quiet before one
 *  refresh. */
const REFRESH_QUIET_MS = 200;

/**
 * Keep a comparison in place while editors move: re-show the diff after
 * each burst of view-column changes. The caller starts it once the
 * `vscode.diff` that opened the comparison has returned, and the debounce
 * takes in any trailing moves of that opening. It runs until interrupted:
 * the caller runs it in a `FiberHandle`, so a newer comparison replaces the
 * older one's refresh.
 */
export function refreshDiffOnLayoutChange(
  left: vscode.Uri,
  right: vscode.Uri,
  title: string,
): Effect.Effect<void> {
  return eventStream(vscode.window.onDidChangeTextEditorViewColumn).pipe(
    // Trailing-edge: a column move fires several events within a few
    // milliseconds, and a leading throttle that dropped the later ones
    // left the diff where the first event found it. The last event
    // always refreshes.
    Stream.debounce(REFRESH_QUIET_MS),
    Stream.runForEach(() =>
      executeVscodeCommand('vscode.diff', left, right, title, {
        preserveFocus: true,
      } satisfies vscode.TextDocumentShowOptions).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Could not refresh the comparison "${title}": ${error.message}`,
          ),
        ),
      ),
    ),
    // Nothing joins this fiber: a listener VS Code would not register is
    // logged here, and the comparison stays as it opened.
    Effect.catchDefect(
      logFailure(
        CHANNEL,
        'Could not register the diff refresh; the comparison will not follow editor moves.',
      ),
    ),
    withLogChannel(CHANNEL),
  );
}
