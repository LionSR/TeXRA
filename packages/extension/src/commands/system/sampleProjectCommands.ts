// Standard library imports
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Cause, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports - fs
import type { SessionHandle } from '@agent/runtime';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { selectFolder } from '@frontend/ui/dialogs';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { withSessionFs, WorkspaceFs } from '@platform/rootedFs';

const CHANNEL = 'SampleProjectCommands';

/** Both entries report a failed creation the same way. */
const reportFailure = (err: unknown) =>
  showLoggedErrorMessage(CHANNEL, 'Failed to create sample project', err).pipe(
    Effect.asVoid,
  );

/**
 * No-workspace variant for the welcome view: ask where to put the sample,
 * copy it there, and open the folder (which reloads the window into full
 * activation, so the regular onboarding takes over). Must not touch
 * `platform()` or a session — the no-workspace activation path returns
 * before `initPlatform()` runs.
 */
export async function createSampleProjectWithoutWorkspace(
  extensionPath: string,
  runtime: ProcessRuntime,
): Promise<void> {
  const create = Effect.gen(function* () {
    const parentPath = yield* selectFolder({
      openLabel: 'Create sample project here',
      title: 'Choose where to create the TeXRA sample project',
    });
    if (!parentPath) {
      return;
    }

    const dest = path.join(parentPath, 'texra-sample');
    if (existsSync(dest)) {
      void vscode.window.showInformationMessage(
        'A texra-sample folder already exists there — opening it.',
      );
    } else {
      yield* Effect.tryPromise({
        try: () =>
          cp(path.join(extensionPath, 'resources', 'examples'), dest, {
            recursive: true,
          }),
        catch: (err: unknown) => err,
      });
    }
    yield* Effect.tryPromise({
      try: async () => {
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(dest),
          { forceNewWindow: false },
        );
      },
      catch: (err: unknown) => err,
    });
  });

  await runtime.runPromise(create.pipe(Effect.catch(reportFailure)));
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
): Effect.Effect<void, never, ProcessServices> {
  return withSessionFs(
    session.roots,
    Effect.gen(function* () {
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
      yield* Effect.promise(() =>
        cp(sourcePath, destPath, {
          recursive: true,
          force: true,
          errorOnExist: false,
        }),
      );

      void vscode.window.showInformationMessage(
        'Created TeXRA sample project.',
      );

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
    }),
    // One terminal boundary for the whole creation, as the single
    // `Effect.catch` over the async body it replaces was: a failed workspace
    // read, a failed tree copy and a failed editor open are reported alike.
  ).pipe(Effect.catchCause((cause) => reportFailure(Cause.squash(cause))));
}
