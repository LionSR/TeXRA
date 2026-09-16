// Standard library imports
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - fs
import type { SessionHandle } from '@agent/runtime';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { selectFolder } from '@frontend/ui/dialogs';
import type { ProcessRuntime } from '@platform/processRuntime';
import { withSessionFs, WorkspaceFs } from '@platform/rootedFs';

const CHANNEL = 'SampleProjectCommands';

/**
 * No-workspace variant for the welcome view: ask where to put the sample,
 * copy it there, and open the folder (which reloads the window into full
 * activation, so the regular onboarding takes over). Must not touch
 * `platform()` or a session — the no-workspace activation path returns
 * before `initPlatform()` runs.
 */
export async function createSampleProjectWithoutWorkspace(
  extensionPath: string,
): Promise<void> {
  try {
    const parentPath = await selectFolder({
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
      await cp(path.join(extensionPath, 'resources', 'examples'), dest, {
        recursive: true,
      });
    }
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(dest),
      { forceNewWindow: false },
    );
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'Failed to create sample project',
      err,
    );
  }
}

/**
 * Copy the bundled sample into the session's workspace and open its
 * README. Every workspace path is named and checked by the session's
 * workspace view; the bundled source lives in the extension, outside every
 * session root, so the tree copy runs at the two absolute paths, with the
 * options the replaced facade used.
 */
export async function createSampleProject(
  extensionPath: string,
  runtime: ProcessRuntime,
  session: SessionHandle,
): Promise<void> {
  try {
    const workspaceFs = await runtime.runPromise(
      withSessionFs(session.roots, WorkspaceFs),
    );
    if (!workspaceFs.root) {
      void showLoggedMessage(
        CHANNEL,
        'Open a workspace to create the sample project.',
      );
      return;
    }

    const destFolder = 'texra-sample';
    if (await runtime.runPromise(workspaceFs.exists(destFolder))) {
      void vscode.window.showInformationMessage(
        'Sample project already exists in workspace.',
      );
      return;
    }

    const sourcePath = path.join(extensionPath, 'resources', 'examples');
    const destPath = await runtime.runPromise(workspaceFs.resolve(destFolder));

    await runtime.runPromise(
      workspaceFs.makeDirectory(destFolder, { recursive: true }),
    );
    await cp(sourcePath, destPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });

    void vscode.window.showInformationMessage('Created TeXRA sample project.');

    const readmeRelativePath = path.join(destFolder, 'README.md');
    if (await runtime.runPromise(workspaceFs.exists(readmeRelativePath))) {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(destPath, 'README.md')),
      );
      await vscode.window.showTextDocument(document, { preview: false });
    }
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'Failed to create sample project',
      err,
    );
  }
}
