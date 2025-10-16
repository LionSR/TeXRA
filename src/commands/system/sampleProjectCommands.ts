// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - fs
import { WorkspaceFS, copyDirToFS } from '@utils/files';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'SampleProjectCommands';
logger.initialize(CHANNEL);

export const sampleProjectCommands = {
  createSampleProject: 'texra.createSampleProject',
};

export function registerSampleProjectCommands(
  context: vscode.ExtensionContext,
) {
  const createSampleProjectCommand = vscode.commands.registerCommand(
    sampleProjectCommands.createSampleProject,
    async () => {
      try {
        if (!WorkspaceFS.getPath()) {
          void vscode.window.showErrorMessage(
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

        const sourcePath = path.join(
          context.extensionPath,
          'resources',
          'examples',
        );

        await copyDirToFS(sourcePath, destFolder, WorkspaceFS);

        void vscode.window.showInformationMessage(
          'Created TeXRA sample project.',
        );

        const readmeRelativePath = path.join(destFolder, 'README.md');
        if (await WorkspaceFS.exists(readmeRelativePath)) {
          const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(WorkspaceFS.fullPath(readmeRelativePath)),
          );
          await vscode.window.showTextDocument(document, { preview: false });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(CHANNEL, `Failed to create sample project: ${message}`);
        void vscode.window.showErrorMessage(
          `Failed to create sample project: ${message}`,
        );
      }
    },
  );

  context.subscriptions.push(createSampleProjectCommand);

  return { createSampleProjectCommand };
}
