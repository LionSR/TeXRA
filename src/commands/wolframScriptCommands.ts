import * as vscode from 'vscode';
import * as path from 'path';

// local import
import {
  checkWolframScriptInstalled,
  executeWolframCode,
  executeWolframScriptFile,
} from '../WolframTool/wolframScriptUtils';

export const wolframScriptCommands = {
  testWolframScript: 'texra.testWolframScript',
  wolframScriptExecute: 'texra.wolframScriptExecute',
  wolframScriptRunFile: 'texra.wolframScriptRunFile',
};

export function registerWolframScriptCommands(
  context: vscode.ExtensionContext,
) {
  // Command to test if wolframscript is installed
  const testWolframScriptCommand = vscode.commands.registerCommand(
    wolframScriptCommands.testWolframScript,
    async () => {
      try {
        const isInstalled = await checkWolframScriptInstalled(false);

        if (isInstalled) {
          vscode.window.showInformationMessage(
            'Wolframscript is properly installed and available.',
          );

          // Perform a simple test evaluation
          const result = await executeWolframCode('N[Pi, 20]', {
            showErrorsToUser: false,
          });

          if (result.success && result.output) {
            vscode.window.showInformationMessage(
              `Wolframscript test successful: ${result.output}`,
            );
          } else {
            vscode.window.showErrorMessage(
              `Wolframscript test failed: ${result.error}`,
            );
          }
        } else {
          vscode.window.showErrorMessage(
            'Wolframscript is not properly installed or not available in PATH.',
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to test Wolframscript: ${err}`);
      }
    },
  );

  // Command to execute Wolfram Language code with user input
  const wolframScriptExecuteCommand = vscode.commands.registerCommand(
    wolframScriptCommands.wolframScriptExecute,
    async () => {
      // Get the code from the user
      const code = await vscode.window.showInputBox({
        prompt: 'Enter Wolfram Language code to execute',
        placeHolder: 'e.g., N[Pi, 20] or Solve[x^2 + 2x + 1 == 0, x]',
      });

      if (!code) {
        return;
      }

      try {
        // Show a progress indicator
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Executing Wolfram Language code...',
            cancellable: false,
          },
          async (progress) => {
            progress.report({ increment: 50 });
            const response = await executeWolframCode(code, {
              timeout: 60000, // 1 minute timeout
              showErrorsToUser: false,
            });
            progress.report({ increment: 50 });
            return response;
          },
        );

        // Create a webview panel to display the result
        const panel = vscode.window.createWebviewPanel(
          'wolframScriptResult',
          'Wolfram Language Result',
          vscode.ViewColumn.One,
          { enableScripts: true },
        );

        const errorContent = result.error
          ? `<div class="error"><h3>Error:</h3><pre>${result.error}</pre></div>`
          : '';

        const outputContent = result.output
          ? `<div class="output"><h3>Output:</h3><pre>${result.output}</pre></div>`
          : '<div class="output"><h3>Output:</h3><pre>No output received.</pre></div>';

        panel.webview.html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <title>Wolfram Language Result</title>
            <style>
              body {
                font-family: var(--vscode-font-family);
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
                padding: 20px;
                margin: 0;
                line-height: 1.5;
              }
              
              h2, h3 {
                margin-top: 0;
                margin-bottom: 16px;
                font-weight: 500;
                color: var(--vscode-editor-foreground);
              }
              
              .input, .output, .error {
                margin-bottom: 20px;
              }
              
              .error pre {
                background-color: var(--vscode-inputValidation-errorBackground);
                border: 1px solid var(--vscode-inputValidation-errorBorder);
              }
              
              pre {
                background-color: var(--vscode-textCodeBlock-background);
                color: var(--vscode-editor-foreground);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 3px;
                padding: 16px;
                overflow: auto;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                white-space: pre-wrap;
              }
            </style>
          </head>
          <body>
            <h2>Wolfram Language Execution</h2>
            <div class="input">
              <h3>Input:</h3>
              <pre>${code}</pre>
            </div>
            ${outputContent}
            ${errorContent}
          </body>
          </html>
        `;
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to execute Wolfram code: ${err}`,
        );
      }
    },
  );

  // Command to run the currently open Wolfram Language file
  const wolframScriptRunFileCommand = vscode.commands.registerCommand(
    wolframScriptCommands.wolframScriptRunFile,
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No file is currently open');
        return;
      }

      const filePath = editor.document.uri.fsPath;
      const fileExtension = path.extname(filePath).toLowerCase();

      // Check if the file is a Wolfram Language file
      if (fileExtension !== '.wl' && fileExtension !== '.m') {
        vscode.window.showErrorMessage(
          'Current file is not a Wolfram Language file. Please open a .wl or .m file.',
        );
        return;
      }

      // Save the document before executing if it has unsaved changes
      if (editor.document.isDirty) {
        await editor.document.save();
      }

      try {
        // Show a progress indicator
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Executing Wolfram Language file: ${path.basename(filePath)}...`,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ increment: 50 });
            const response = await executeWolframScriptFile(filePath, {
              timeout: 120000, // 2 minute timeout for files
              showErrorsToUser: false,
            });
            progress.report({ increment: 50 });
            return response;
          },
        );

        // Read a sample of the file content to display in the result
        const fileContent = editor.document.getText();
        const sampleContent =
          fileContent.length > 1000
            ? `${fileContent.substring(0, 1000)}...`
            : fileContent;

        // Create a webview panel to display the result
        const panel = vscode.window.createWebviewPanel(
          'wolframScriptFileResult',
          `Wolfram Script Result: ${path.basename(filePath)}`,
          vscode.ViewColumn.One,
          { enableScripts: true },
        );

        const errorContent = result.error
          ? `<div class="error"><h3>Error:</h3><pre>${result.error}</pre></div>`
          : '';

        const outputContent = result.output
          ? `<div class="output"><h3>Output:</h3><pre>${result.output}</pre></div>`
          : '<div class="output"><h3>Output:</h3><pre>No output received.</pre></div>';

        panel.webview.html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <title>Wolfram Script File Result</title>
            <style>
              body {
                font-family: var(--vscode-font-family);
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
                padding: 20px;
                margin: 0;
                line-height: 1.5;
              }
              
              h2, h3 {
                margin-top: 0;
                margin-bottom: 16px;
                font-weight: 500;
                color: var(--vscode-editor-foreground);
              }
              
              .file-info {
                margin-bottom: 10px;
                font-style: italic;
              }
              
              .input, .output, .error {
                margin-bottom: 20px;
              }
              
              .error pre {
                background-color: var(--vscode-inputValidation-errorBackground);
                border: 1px solid var(--vscode-inputValidation-errorBorder);
              }
              
              pre {
                background-color: var(--vscode-textCodeBlock-background);
                color: var(--vscode-editor-foreground);
                border: 1px solid var(--vscode-panel-border);
                border-radius: 3px;
                padding: 16px;
                overflow: auto;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                white-space: pre-wrap;
              }
            </style>
          </head>
          <body>
            <h2>Wolfram Script File Execution</h2>
            <div class="file-info">File: ${filePath}</div>
            <div class="input">
              <h3>File Content (sample):</h3>
              <pre>${sampleContent.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
            </div>
            ${outputContent}
            ${errorContent}
          </body>
          </html>
        `;
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to execute Wolfram script file: ${err}`,
        );
      }
    },
  );

  context.subscriptions.push(
    testWolframScriptCommand,
    wolframScriptExecuteCommand,
    wolframScriptRunFileCommand,
  );

  return {
    testWolframScriptCommand,
    wolframScriptExecuteCommand,
    wolframScriptRunFileCommand,
  };
}
