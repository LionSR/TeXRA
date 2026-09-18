// Third-party imports
import { Effect, Fiber } from 'effect';
import * as vscode from 'vscode';

// Local imports - common
import { DiagnosticsReadFailed } from '@agent/runtime';
import { isTexFile } from '@common/files/fileTypeUtils';
import { invokeLatexWorkshopBuild } from '@frontend/latex/openBuild';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { waitForDiagnosticsChange } from '@frontend/vscode/vscodeDiagnostics';

const CHANNEL = 'LinterUtils';
const DIAGNOSTIC_UPDATE_TIMEOUT_MS = 7500;

/**
 * Retrieve linter diagnostics for a file, triggering a LaTeX build first for
 * `.tex` files so the diagnostics are current.
 *
 * `filePath` is already absolute: the diagnostics tool resolves the model's
 * input against its tool root before calling.
 *
 * Each of the two stages fails as its own `DiagnosticsReadFailed` reason, so
 * the diagnostics tool can tell the agent which one gave out instead of
 * reporting an unknown rejection.
 */
export const getLinterMessages = Effect.fn('linter.getLinterMessages')(
  function* (
    filePath: string,
  ): Effect.fn.Return<vscode.Diagnostic[], DiagnosticsReadFailed> {
    const fileUri = vscode.Uri.file(filePath);

    if (isTexFile(filePath)) {
      yield* triggerLaTeXBuild(filePath, fileUri);
    }

    return yield* Effect.try({
      try: () => vscode.languages.getDiagnostics(fileUri),
      catch: (cause) =>
        new DiagnosticsReadFailed({
          reason: 'read-failed',
          path: filePath,
          message: 'VS Code would not report diagnostics for this file.',
          cause,
        }),
    });
  },
);

/**
 * Trigger a LaTeX build and wait for diagnostics to update.
 *
 * Every stage fails as the same `build-failed` reason: the caller cannot act
 * differently on a file that would not open than on a build that would not
 * start, and both leave the diagnostics just as stale.
 */
const triggerLaTeXBuild = (
  filePath: string,
  fileUri: vscode.Uri,
): Effect.Effect<void, DiagnosticsReadFailed> => {
  const buildFailed = (cause: unknown) =>
    new DiagnosticsReadFailed({
      reason: 'build-failed',
      path: filePath,
      message: 'The LaTeX build that refreshes diagnostics failed.',
      cause,
    });

  return Effect.gen(function* () {
    yield* openFileInEditor(fileUri.fsPath, {
      preserveFocus: true,
      save: true,
      reuseVisible: true,
    }).pipe(Effect.mapError(buildFailed));

    // Subscribed on this frame, before the build is triggered, so an update
    // the build produces is not missed. The wait is the `finally` of the
    // build attempt: the build command never fails on its own — it warn-logs
    // — so sequencing the two is what makes the wait run however the build
    // went.
    const diagnosticsWait = yield* Effect.forkChild(
      waitForDiagnosticsChange(fileUri, DIAGNOSTIC_UPDATE_TIMEOUT_MS),
      { startImmediately: true },
    );

    yield* invokeLatexWorkshopBuild(
      fileUri,
      CHANNEL,
      'Failed to trigger LaTeX build',
    );
    yield* Fiber.join(diagnosticsWait);
  });
};
