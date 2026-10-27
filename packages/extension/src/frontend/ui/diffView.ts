import { Effect, Queue, Stream } from 'effect';
import * as vscode from 'vscode';

import { withLogChannel } from '@texra-ai/harness';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { DIFF_REGISTRATION_DELAY_MS } from '@texra/shared/constants/latexTiming';

const CHANNEL = 'DiffView';

/** How long a burst of view-column changes settles before one refresh. */
const REFRESH_SETTLE_MS = 200;

/**
 * Keep a comparison in place while editors move: re-show the diff after
 * each burst of view-column changes. It starts listening after
 * `DIFF_REGISTRATION_DELAY_MS`, so the moves the diff's own opening caused
 * are not answered, and runs until interrupted: the caller runs it in a
 * `FiberHandle`, so a newer comparison replaces the older one's refresh.
 */
export function refreshDiffOnLayoutChange(
  left: vscode.Uri,
  right: vscode.Uri,
  title: string,
): Effect.Effect<void> {
  const viewColumnChanges = Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        vscode.window.onDidChangeTextEditorViewColumn(() =>
          Queue.offerUnsafe(queue, undefined),
        ),
      ),
      (listener) => Effect.sync(() => listener.dispose()),
    ),
  );
  return Effect.sleep(DIFF_REGISTRATION_DELAY_MS).pipe(
    Effect.andThen(
      viewColumnChanges.pipe(
        // Trailing-edge: a column move fires several events within a few
        // milliseconds, and a leading throttle that dropped the later ones
        // left the diff where the first event found it. The last event
        // always refreshes.
        Stream.debounce(REFRESH_SETTLE_MS),
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
      ),
    ),
    // Nothing joins this fiber: a listener VS Code would not register is
    // logged here, and the comparison stays as it opened.
    Effect.catchDefect((defect) =>
      Effect.logWarning(
        'Could not register the diff refresh; the comparison will not follow editor moves.',
      ).pipe(Effect.annotateLogs({ data: defect })),
    ),
    withLogChannel(CHANNEL),
  );
}
