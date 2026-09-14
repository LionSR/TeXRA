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
      yield* Effect.tryPromise({
        try: () => triggerLaTeXBuild(filePath, fileUri),
        catch: (cause) =>
          new DiagnosticsReadFailed({
            reason: 'build-failed',
            path: filePath,
            message: 'The LaTeX build that refreshes diagnostics failed.',
            cause,
          }),
      });
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
 */
async function triggerLaTeXBuild(
  filePath: string,
  fileUri: vscode.Uri,
): Promise<void> {
  await openFileInEditor(fileUri.fsPath, {
    preserveFocus: true,
    save: true,
    reuseVisible: true,
  });

  const diagnosticsWait = waitForDiagnosticsChange(
    fileUri,
    DIAGNOSTIC_UPDATE_TIMEOUT_MS,
  );

  try {
    await invokeLatexWorkshopBuild(
      fileUri,
      CHANNEL,
      'Failed to trigger LaTeX build',
    );
  } finally {
    await diagnosticsWait;
  }
}
