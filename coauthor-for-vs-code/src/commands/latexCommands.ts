import * as vscode from 'vscode';
import { runLatexIndent } from '../utils/texUtils';
import { debug, error, initializeLogging } from '../utils/logUtils';
import { fileSelectionCommands } from './fileSelection';

const CHANNEL = 'LaTeXCommands';
initializeLogging(CHANNEL);

export const latexCommands = {
  indentCurrentTex: 'coauthor.indentCurrentTex',
};

export function registerLatexCommands(context: vscode.ExtensionContext) {
  const disposables = [
    vscode.commands.registerCommand(
      latexCommands.indentCurrentTex,
      async () => {
        try {
          const relativePath = await fileSelectionCommands.getCurrentFile();
          if (!relativePath) {
            vscode.window.showWarningMessage('No active text editor found');
            return;
          }

          if (!relativePath.endsWith('.tex')) {
            vscode.window.showWarningMessage(
              'Active file is not a LaTeX document (.tex)',
            );
            return;
          }

          debug(CHANNEL, `Indenting LaTeX file: ${relativePath}`);

          // Save any unsaved changes
          const editor = vscode.window.activeTextEditor;
          if (editor?.document.isDirty) {
            await editor.document.save();
          }

          // Run the indent operation with relative path
          const success = await runLatexIndent(relativePath);

          if (success) {
            // Instead of trying to modify the document directly,
            // let VS Code handle the file change notification
            await new Promise((resolve) => setTimeout(resolve, 100)); // Small delay to ensure file is written
            vscode.window.showInformationMessage(
              'LaTeX file indented successfully',
            );
          } else {
            vscode.window.showErrorMessage('Failed to indent LaTeX file');
          }
        } catch (err) {
          error(CHANNEL, `Error in indentTex command: ${err}`);
          vscode.window.showErrorMessage('Error indenting LaTeX file');
        }
      },
    ),
  ];

  context.subscriptions.push(...disposables);
  return disposables;
}
