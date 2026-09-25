// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Cause, Effect, FileSystem, type PlatformError } from 'effect';
import * as vscode from 'vscode';

// Local imports - fs
import type { SessionHandle } from '@agent/runtime';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { selectFolder } from '@frontend/ui/dialogs';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { WorkspaceFs } from '@platform/rootedFs';
import { ensureError } from '@utils/errors/errorMessage';

const CHANNEL = 'SampleProjectCommands';

/** Both entries report a failed creation the same way. */
const reportFailure = (err: unknown) =>
  showLoggedErrorMessage(CHANNEL, 'Failed to create sample project', err).pipe(
    Effect.asVoid,
  );

/**
 * No-workspace variant for the welcome view: ask where to put the sample,
 * copy it there, and open the folder (which reloads the window into full
 * activation, so the regular onboarding takes over). Must not touch a
 * session — the no-workspace activation path returns before one exists.
 */
export async function createSampleProjectWithoutWorkspace(
  extensionPath: string,
  runtime: ProcessRuntime,
): Promise<void> {
  const create = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parentPath = yield* selectFolder({
      openLabel: 'Create sample project here',
      title: 'Choose where to create the TeXRA sample project',
    });
    if (!parentPath) {
      return;
    }

    const dest = path.join(parentPath, 'texra-sample');
    if (yield* fs.exists(dest)) {
      void vscode.window.showInformationMessage(
        'A texra-sample folder already exists there — opening it.',
      );
    } else {
      yield* fs.copy(path.join(extensionPath, 'resources', 'examples'), dest);
    }
    yield* Effect.tryPromise({
      try: async () => {
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(dest),
          { forceNewWindow: false },
        );
      },
      catch: ensureError,
    });
  });

  await runtime.runPromise(
    create.pipe(
      Effect.catch((error: PlatformError.PlatformError | Error) =>
        reportFailure(error),
      ),
    ),
  );
}

/**
 * Copy the bundled sample into the session's workspace and open its
 * README. Every workspace path is named and checked by the session's
 * workspace view; the bundled source lives in the extension, outside every
 * session root, so the tree copy runs at the two absolute paths, with the
 * options the replaced facade used.
 */
export function createSampleProject(
  extensionPath: string,
  session: SessionHandle,
): Effect.Effect<void, never, ProcessServices | WorkspaceFs> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceFs = yield* WorkspaceFs;
    if (!workspaceFs.root) {
      yield* Effect.forkDetach(
        showLoggedMessage(
          CHANNEL,
          'Open a workspace to create the sample project.',
        ),
      );
      return;
    }

    const destFolder = 'texra-sample';
    if (yield* workspaceFs.exists(destFolder)) {
      void vscode.window.showInformationMessage(
        'Sample project already exists in workspace.',
      );
      return;
    }

    const sourcePath = path.join(extensionPath, 'resources', 'examples');
    const destPath = yield* workspaceFs.resolve(destFolder);

    yield* workspaceFs.makeDirectory(destFolder, { recursive: true });
    yield* fs.copy(sourcePath, destPath, { overwrite: true });

    void vscode.window.showInformationMessage('Created TeXRA sample project.');

    const readmeRelativePath = path.join(destFolder, 'README.md');
    if (yield* workspaceFs.exists(readmeRelativePath)) {
      const document = yield* Effect.promise(() =>
        vscode.workspace.openTextDocument(
          vscode.Uri.file(path.join(destPath, 'README.md')),
        ),
      );
      yield* Effect.promise(() =>
        vscode.window.showTextDocument(document, { preview: false }),
      );
    }
    // One terminal boundary for the whole creation, as the single
    // `Effect.catch` over the async body it replaces was: a failed workspace
    // read, a failed tree copy and a failed editor open are reported alike.
  }).pipe(Effect.catchCause((cause) => reportFailure(Cause.squash(cause))));
}
