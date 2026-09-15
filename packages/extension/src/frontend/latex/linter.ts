// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports - common
import { currentSession, DiagnosticsReadFailed } from '@agent/runtime';
import { isTexFile } from '@common/files/fileTypeUtils';
import { invokeLatexWorkshopBuild } from '@frontend/latex/openBuild';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import { waitForDiagnosticsChange } from '@frontend/vscode/vscodeDiagnostics';
import { workspaceAbsolutePath } from '@utils/files/workspaceFS';

const CHANNEL = 'LinterUtils';
const DIAGNOSTIC_UPDATE_TIMEOUT_MS = 7500;

/**
 * Retrieve linter diagnostics for a file, triggering a LaTeX build first for
 * `.tex` files so the diagnostics are current.
 *
 * The session's workspace root is read on this program's first step, before
 * the build suspends it, because the root comes from the caller's ambient
 * session and a resumed fiber frame no longer carries it.
 *
 * Each of the three stages fails as its own `DiagnosticsReadFailed` reason, so
 * the diagnostics tool can tell the agent which one gave out instead of
 * reporting an unknown rejection.
 */
export const getLinterMessages = Effect.fn('linter.getLinterMessages')(
  function* (
    filePath: string,
  ): Effect.fn.Return<vscode.Diagnostic[], DiagnosticsReadFailed> {
    const fileUri = yield* Effect.try({
      try: () =>
        vscode.Uri.file(
          workspaceAbsolutePath(currentSession().roots.workspace, filePath),
        ),
      catch: (cause) =>
        new DiagnosticsReadFailed({
          reason: 'workspace-unavailable',
          path: filePath,
          message: 'No workspace root resolves this file.',
          cause,
        }),
    });

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
    yield* Effect.tryPromise({
      try: () =>
        openFileInEditor(fileUri.fsPath, {
          preserveFocus: true,
          save: true,
          reuseVisible: true,
        }),
      catch: buildFailed,
    });

    const diagnosticsWait = waitForDiagnosticsChange(
      fileUri,
      DIAGNOSTIC_UPDATE_TIMEOUT_MS,
    );

    // The wait is the `finally` of the build attempt: the build command never
    // fails on its own — it warn-logs — so sequencing the two is what makes
    // the wait run however the build went.
    yield* invokeLatexWorkshopBuild(
      fileUri,
      CHANNEL,
      'Failed to trigger LaTeX build',
    );
    yield* Effect.tryPromise({
      try: () => diagnosticsWait,
      catch: buildFailed,
    });
  });
};
