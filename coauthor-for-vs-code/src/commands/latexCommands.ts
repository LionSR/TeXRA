import * as vscode from 'vscode';
import * as path from 'path';
import { runLatexIndent } from '../utils/texUtils';
import { debug, error, initializeLogging } from '../utils/logUtils';

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
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            vscode.window.showWarningMessage('No active text editor found');
            return;
          }

          const document = editor.document;
          if (!document.fileName.endsWith('.tex')) {
            vscode.window.showWarningMessage(
              'Active file is not a LaTeX document (.tex)',
            );
            return;
          }

          // Get workspace folder
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
          if (!workspaceFolder) {
            vscode.window.showErrorMessage('File must be within a workspace');
            return;
          }

          // Convert to workspace-relative path
          const absolutePath = document.uri.fsPath;
          const relativePath = path.relative(workspaceFolder.uri.fsPath, absolutePath);
          
          if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            vscode.window.showErrorMessage('File must be within the workspace');
            return;
          }

          debug(CHANNEL, `Indenting LaTeX file: ${relativePath}`);

          // Save any unsaved changes
          if (document.isDirty) {
            await document.save();
          }

          // Run the indent operation with relative path
          const success = await runLatexIndent(relativePath);
          
          if (success) {
            // Reload the file content after successful indentation
            const edit = new vscode.WorkspaceEdit();
            const content = await vscode.workspace.fs.readFile(document.uri);
            const text = Buffer.from(content).toString('utf-8');
            
            edit.replace(
              document.uri,
              new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
              ),
              text
            );
            
            await vscode.workspace.applyEdit(edit);
            vscode.window.showInformationMessage('LaTeX file indented successfully');
          } else {
            vscode.window.showErrorMessage('Failed to indent LaTeX file');
          }
        } catch (err) {
          error(CHANNEL, `Error in indentTex command: ${err}`);
          vscode.window.showErrorMessage('Error indenting LaTeX file');
        }
      }
    ),
  ];

  context.subscriptions.push(...disposables);
  return disposables;
}
