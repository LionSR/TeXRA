// Standard library imports
import * as path from 'path';

// Third-party imports
import fsExtra from 'fs-extra';
import * as vscode from 'vscode';

// Local imports - fs
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

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

        await WorkspaceFS.ensureDir(destFolder);
        await fsExtra.copy(sourcePath, WorkspaceFS.fullPath(destFolder), {
          overwrite: true,
        });

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
        const message = toErrorMessage(err);
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
