import * as vscode from 'vscode';

// local import
import { WolframAlphaClient } from '../WolframTool/wolframAlphaUtils';

export const wolframAlphaCommands = {
  testWolframAlpha: 'texra.testWolframAlpha',
  wolframAlphaQuery: 'texra.wolframAlphaQuery',
};

export function registerWolframAlphaCommands(context: vscode.ExtensionContext) {
  // Command to test the WolframAlpha API connection
  const testWolframAlphaCommand = vscode.commands.registerCommand(
    wolframAlphaCommands.testWolframAlpha,
    async () => {
      try {
        const wolframClient = new WolframAlphaClient();
        await wolframClient.initialize();

        vscode.window.showInformationMessage(
          'Successfully initialized Wolfram Alpha client',
        );

        // Perform a simple test query
        const query = 'What is the capital of France?';
        const result = await wolframClient.performQuery(query);

        if (result.status === 'success' && result.data) {
          vscode.window.showInformationMessage(
            `Wolfram Alpha test successful: ${result.data.substring(0, 100)}...`,
          );
        } else {
          vscode.window.showErrorMessage(
            `Wolfram Alpha test failed: ${result.message}`,
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to test Wolfram Alpha API: ${err}`,
        );
      }
    },
  );

  // Command to query WolframAlpha with user input
  const wolframAlphaQueryCommand = vscode.commands.registerCommand(
    wolframAlphaCommands.wolframAlphaQuery,
    async () => {
      // Get the query from the user
      const query = await vscode.window.showInputBox({
        prompt: 'Enter your Wolfram Alpha query',
        placeHolder: 'e.g., Solve x^2 + 2x + 1 = 0',
      });

      if (!query) {
        return;
      }

      try {
        const wolframClient = new WolframAlphaClient();
        await wolframClient.initialize();

        // Show a progress indicator
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Querying Wolfram Alpha...',
            cancellable: false,
          },
          async (progress) => {
            progress.report({ increment: 50 });
            const response = await wolframClient.performQuery(query);
            progress.report({ increment: 50 });
            return response;
          },
        );

        if (result.status === 'success' && result.data) {
          // Create a webview panel to display the result
          const panel = vscode.window.createWebviewPanel(
            'wolframAlphaResult',
            'Wolfram Alpha Result',
            vscode.ViewColumn.One,
            { enableScripts: true },
          );

          panel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
              <title>Wolfram Alpha Result</title>
              <style>
                body {
                  font-family: var(--vscode-font-family);
                  color: var(--vscode-editor-foreground);
                  background-color: var(--vscode-editor-background);
                  padding: 20px;
                  margin: 0;
                  line-height: 1.5;
                }
                
                h2 {
                  margin-top: 0;
                  margin-bottom: 16px;
                  font-weight: 500;
                  color: var(--vscode-editor-foreground);
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
                
                a {
                  color: var(--vscode-textLink-foreground);
                  text-decoration: none;
                }
                
                a:hover {
                  text-decoration: underline;
                  color: var(--vscode-textLink-activeForeground);
                }
              </style>
            </head>
            <body>
              <h2>Query: ${query}</h2>
              <pre>${result.data}</pre>
            </body>
            </html>
          `;
        } else {
          vscode.window.showErrorMessage(
            `Wolfram Alpha query failed: ${result.message}`,
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to query Wolfram Alpha: ${err}`);
      }
    },
  );

  context.subscriptions.push(testWolframAlphaCommand, wolframAlphaQueryCommand);

  return {
    testWolframAlphaCommand,
    wolframAlphaQueryCommand,
  };
}
