// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - Anthropic Tool
import { TextEditorTool, ToolCallInput } from '../AnthropicTool';

// Local imports - utilities
import { getRelativePath } from '../utils/workspaceFileUtils';

const CHANNEL = 'TextEditorCommands';
logger.initialize(CHANNEL);

export function registerTextEditorCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.testTextEditor',
      handleTestTextEditor,
    ),
  );
}

/**
 * Handle the test text editor command
 * This command allows testing the TextEditorTool with different commands
 */
async function handleTestTextEditor(): Promise<void> {
  try {
    // Get active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(
        'Please open a file first to use as the target',
      );
      return;
    }

    const filePath = getRelativePath(editor.document.fileName);
    logger.info(CHANNEL, `Testing text editor tool with file: ${filePath}`);

    // Get command to test
    const command = await vscode.window.showQuickPick(
      ['view', 'str_replace', 'insert', 'create', 'undo_edit'],
      {
        placeHolder: 'Select a command to test',
        canPickMany: false,
      },
    );

    if (!command) {
      return; // User cancelled
    }

    // Create the TextEditorTool instance
    const textEditorTool = new TextEditorTool();
    logger.debug(
      CHANNEL,
      `Created TextEditorTool instance with command: ${command}`,
    );

    // Prepare input based on selected command
    const input: ToolCallInput = { command: command as any, path: filePath };

    switch (command) {
      case 'view':
        // Ask if user wants to specify a range
        const useRange = await vscode.window.showQuickPick(['Yes', 'No'], {
          placeHolder: 'Specify a line range?',
        });

        if (useRange === 'Yes') {
          const startLine = await vscode.window.showInputBox({
            prompt: 'Enter start line number',
            validateInput: (value) => {
              const num = parseInt(value);
              return isNaN(num) || num < 1
                ? 'Please enter a valid line number'
                : '';
            },
          });

          const endLine = await vscode.window.showInputBox({
            prompt: 'Enter end line number (or -1 for end of file)',
            validateInput: (value) => {
              const num = parseInt(value);
              return isNaN(num) ? 'Please enter a valid line number' : '';
            },
          });

          if (startLine && endLine) {
            input.view_range = [parseInt(startLine), parseInt(endLine)];
          }
        }
        break;

      case 'str_replace':
        // Get text to replace and replacement text
        const oldStr = await vscode.window.showInputBox({
          prompt: 'Enter text to replace',
        });

        if (!oldStr) {
          vscode.window.showErrorMessage('Text to replace is required');
          return;
        }

        const newStr = await vscode.window.showInputBox({
          prompt: 'Enter replacement text',
        });

        input.old_str = oldStr;
        input.new_str = newStr || '';
        break;

      case 'insert':
        // Get line number and text to insert
        const insertLine = await vscode.window.showInputBox({
          prompt: 'Enter line number to insert at',
          validateInput: (value) => {
            const num = parseInt(value);
            return isNaN(num) || num < 0
              ? 'Please enter a valid line number (0 or greater)'
              : '';
          },
        });

        if (!insertLine) {
          return;
        }

        const textToInsert = await vscode.window.showInputBox({
          prompt: 'Enter text to insert',
        });

        if (!textToInsert) {
          vscode.window.showErrorMessage('Text to insert is required');
          return;
        }

        input.insert_line = parseInt(insertLine);
        input.new_str = textToInsert;
        break;

      case 'create':
        // Get file path and content for new file
        const newFilePath = await vscode.window.showInputBox({
          prompt: 'Enter path for new file (relative to workspace)',
          value: 'new_file.txt',
        });

        if (!newFilePath) {
          return;
        }

        const fileContent = await vscode.window.showInputBox({
          prompt: 'Enter content for the new file',
        });

        if (!fileContent) {
          vscode.window.showErrorMessage('File content is required');
          return;
        }

        input.path = newFilePath;
        input.file_text = fileContent;
        break;

      case 'undo_edit':
        // No additional input needed
        break;

      default:
        vscode.window.showErrorMessage(`Unsupported command: ${command}`);
        return;
    }

    // Execute the tool and log results
    logger.info(
      CHANNEL,
      `Executing text editor tool with input: ${JSON.stringify(input)}`,
    );

    const result = await textEditorTool.call(input);

    if (result.isError) {
      logger.error(CHANNEL, `Error from text editor tool: ${result.error}`);
      vscode.window.showErrorMessage(`Error: ${result.error}`);
    } else {
      logger.info(CHANNEL, `Success from text editor tool: ${result.output}`);

      // Show output in a temporary file
      const outputDoc = await vscode.workspace.openTextDocument({
        content: result.output || 'No output',
        language: 'text',
      });

      await vscode.window.showTextDocument(outputDoc, {
        viewColumn: vscode.ViewColumn.Beside,
      });
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in testTextEditor command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error testing text editor tool');
  }
}

export const textEditorCommands = {
  handleTestTextEditor,
};
