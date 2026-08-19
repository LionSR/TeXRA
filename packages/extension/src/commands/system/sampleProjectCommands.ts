// Standard library imports
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - fs
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { selectFolder } from '@frontend/ui/dialogs';
import { WorkspaceFS } from '@utils/files/workspaceFS';

const CHANNEL = 'SampleProjectCommands';

/**
 * No-workspace variant for the welcome view: ask where to put the sample,
 * copy it there, and open the folder (which reloads the window into full
 * activation, so the regular onboarding takes over). Must not touch
 * `platform()`/`WorkspaceFS` — the no-workspace activation path returns
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

export async function createSampleProject(
  extensionPath: string,
): Promise<void> {
  try {
    if (!WorkspaceFS.getPath()) {
      void showLoggedMessage(
        CHANNEL,
        'Open a workspace to create the sample project.',
      );
      return;
    }

    const destFolder = 'texra-sample';
    if (await WorkspaceFS.exists(destFolder)) {
      void vscode.window.showInformationMessage(
        'Sample project already exists in workspace.',
      );
      return;
    }

    const sourcePath = path.join(extensionPath, 'resources', 'examples');

    await WorkspaceFS.ensureDir(destFolder);
    await WorkspaceFS.copy(sourcePath, destFolder, { overwrite: true });

    void vscode.window.showInformationMessage('Created TeXRA sample project.');

    const readmeRelativePath = path.join(destFolder, 'README.md');
    if (await WorkspaceFS.exists(readmeRelativePath)) {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(WorkspaceFS.fullPath(readmeRelativePath)),
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
