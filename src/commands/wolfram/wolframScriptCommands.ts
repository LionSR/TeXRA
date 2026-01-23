// Third-party imports
import * as path from 'path';
import * as vscode from 'vscode';

// Local imports - log
import { showLoggedMessage, showLoggedMessageWithDocs } from '@common/errors';
import * as logger from '@logger/logUtils';
import {
  executeWolframCode,
  executeWolframScriptFile,
} from '@tools/wolfram/wolframScriptUtils';
import { checkToolInstalled } from '@utils/system';
import { MAX_PREVIEW_LENGTH } from '@utils/config';

export const wolframScriptCommands = {
  testWolframScript: 'texra.testWolframScript',
  wolframScriptExecute: 'texra.wolframScriptExecute',
  wolframScriptRunFile: 'texra.wolframScriptRunFile',
};

const CHANNEL = 'WolframScriptCommands';
logger.initialize(CHANNEL);

/** Common CSS styles for Wolfram result webviews */
const WOLFRAM_RESULT_STYLES = `
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
`;

interface WolframResultContent {
  output: string | null;
  error: string | null;
  timedOut: boolean;
  exitCode: number | null;
}

/** Build HTML content sections for Wolfram result display */
function buildResultSections(result: WolframResultContent): {
  outputHtml: string;
  errorHtml: string;
} {
  // Build error section with all available diagnostic info
  const errorParts: string[] = [];
  if (result.timedOut) {
    errorParts.push('Execution timed out');
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    errorParts.push(`Exit code: ${result.exitCode}`);
  }
  if (result.error) {
    errorParts.push(result.error);
  }

  const errorHtml =
    errorParts.length > 0
      ? `<div class="error"><h3>Error:</h3><pre>${errorParts.join('\n')}</pre></div>`
      : '';

  const outputHtml = result.output
    ? `<div class="output"><h3>Output:</h3><pre>${result.output}</pre></div>`
    : '<div class="output"><h3>Output:</h3><pre>No output received.</pre></div>';

  return { outputHtml, errorHtml };
}

/** Generate complete HTML for Wolfram result webview */
function createResultHtml(
  title: string,
  heading: string,
  inputSection: string,
  result: WolframResultContent,
): string {
  const { outputHtml, errorHtml } = buildResultSections(result);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>${title}</title>
  <style>${WOLFRAM_RESULT_STYLES}</style>
</head>
<body>
  <h2>${heading}</h2>
  ${inputSection}
  ${outputHtml}
  ${errorHtml}
</body>
</html>`;
}

export function registerWolframScriptCommands(
  context: vscode.ExtensionContext,
) {
  // Command to test if wolframscript is installed
  const testWolframScriptCommand = vscode.commands.registerCommand(
    wolframScriptCommands.testWolframScript,
    async () => {
      try {
        const isInstalled = await checkToolInstalled('wolframscript', false);

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
            const errorParts: string[] = [];
            if (result.timedOut) errorParts.push('timed out');
            if (result.exitCode !== null && result.exitCode !== 0)
              errorParts.push(`exit code ${result.exitCode}`);
            if (result.error) errorParts.push(result.error);
            const errorMsg =
              errorParts.length > 0 ? errorParts.join('; ') : 'unknown error';
            await showLoggedMessageWithDocs(
              CHANNEL,
              `Wolframscript test failed: ${errorMsg}. See Tool Integration for setup instructions.`,
              'tool-integration',
              'Open Tool Integration Docs',
            );
          }
        } else {
          await showLoggedMessageWithDocs(
            CHANNEL,
            'Wolframscript is not properly installed or not available in PATH. See Tool Integration for setup instructions.',
            'tool-integration',
            'Open Tool Integration Docs',
          );
        }
      } catch (err) {
        await showLoggedMessageWithDocs(
          CHANNEL,
          `Failed to test Wolframscript: ${err}. See Tool Integration for setup instructions.`,
          'tool-integration',
          'Open Tool Integration Docs',
        );
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

        const inputSection = `<div class="input"><h3>Input:</h3><pre>${code}</pre></div>`;
        panel.webview.html = createResultHtml(
          'Wolfram Language Result',
          'Wolfram Language Execution',
          inputSection,
          result,
        );
      } catch (err) {
        await showLoggedMessageWithDocs(
          CHANNEL,
          `Failed to execute Wolfram code: ${err}. See Tool Integration for setup instructions.`,
          'tool-integration',
          'Open Tool Integration Docs',
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
        await showLoggedMessage(CHANNEL, 'No file is currently open');
        return;
      }

      const filePath = editor.document.uri.fsPath;
      const fileExtension = path.extname(filePath).toLowerCase();

      // Check if the file is a Wolfram Language file
      if (fileExtension !== '.wl' && fileExtension !== '.m') {
        await showLoggedMessage(
          CHANNEL,
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
          fileContent.length > MAX_PREVIEW_LENGTH
            ? `${fileContent.substring(0, MAX_PREVIEW_LENGTH)}...`
            : fileContent;

        // Create a webview panel to display the result
        const panel = vscode.window.createWebviewPanel(
          'wolframScriptFileResult',
          `Wolfram Script Result: ${path.basename(filePath)}`,
          vscode.ViewColumn.One,
          { enableScripts: true },
        );

        const escapedContent = sampleContent
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
        const inputSection = `<div class="file-info">File: ${filePath}</div>
          <div class="input"><h3>File Content (sample):</h3><pre>${escapedContent}</pre></div>`;
        panel.webview.html = createResultHtml(
          'Wolfram Script File Result',
          'Wolfram Script File Execution',
          inputSection,
          result,
        );
      } catch (err) {
        await showLoggedMessageWithDocs(
          CHANNEL,
          `Failed to execute Wolfram script file: ${err}. See Tool Integration for setup instructions.`,
          'tool-integration',
          'Open Tool Integration Docs',
        );
      }
    },
  );

  context.subscriptions.push(
    testWolframScriptCommand,
    wolframScriptExecuteCommand,
    wolframScriptRunFileCommand,
  );
}
