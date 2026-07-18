// Third-party imports
import * as vscode from 'vscode';

// Local imports - Tool implementations
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import {
  TextEditorTool,
  type EditorCommand,
  type TextEditorInput,
} from '@tools/TextEditorTool';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'TextEditorCommands';

// Prompt for a line number, rejecting non-numeric input and (when `min` is
// given) values below the floor. Shared by the start/end/insert prompts.
async function promptLineNumber(
  prompt: string,
  errorMessage: string,
  min?: number,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    validateInput: (value) => {
      const num = Number.parseInt(value, 10);
      if (Number.isNaN(num) || (min !== undefined && num < min)) {
        return errorMessage;
      }
      return '';
    },
  });
}

/**
 * Handle the test text editor command
 * This command allows testing the TextEditorTool with different commands
 */
export async function handleTestTextEditor(): Promise<void> {
  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(
        'Please open a file first to use as the target',
      );
      return;
    }

    const filePath = WorkspaceFS.relativePath(editor.document.fileName);
    logger.info(CHANNEL, `Testing text editor tool with file: ${filePath}`);

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

    const textEditorTool = new TextEditorTool();
    logger.debug(
      CHANNEL,
      `Created TextEditorTool instance with command: ${command}`,
    );

    // Type assertion is safe because showQuickPick options match EditorCommand values
    const input: TextEditorInput = {
      command: command as EditorCommand,
      path: filePath,
    };

    switch (command) {
      case 'view':
        const useRange = await vscode.window.showQuickPick(['Yes', 'No'], {
          placeHolder: 'Specify a line range?',
        });

        if (useRange === 'Yes') {
          const startLine = await promptLineNumber(
            'Enter start line number',
            'Please enter a valid line number',
            1,
          );

          const endLine = await promptLineNumber(
            'Enter end line number (or -1 for end of file)',
            'Please enter a valid line number',
          );

          if (startLine && endLine) {
            input.view_range = [
              Number.parseInt(startLine, 10),
              Number.parseInt(endLine, 10),
            ];
          }
        }
        break;

      case 'str_replace':
        const oldStr = await vscode.window.showInputBox({
          prompt: 'Enter text to replace',
        });

        if (!oldStr) {
          void showLoggedMessage(CHANNEL, 'Text to replace is required');
          return;
        }

        const newStr = await vscode.window.showInputBox({
          prompt: 'Enter replacement text',
        });

        input.old_str = oldStr;
        input.new_str = newStr ?? '';
        break;

      case 'insert':
        const insertLine = await promptLineNumber(
          'Enter line number to insert at',
          'Please enter a valid line number (0 or greater)',
          0,
        );

        if (!insertLine) {
          return;
        }

        const textToInsert = await vscode.window.showInputBox({
          prompt: 'Enter text to insert',
        });

        if (!textToInsert) {
          void showLoggedMessage(CHANNEL, 'Text to insert is required');
          return;
        }

        input.insert_line = Number.parseInt(insertLine, 10);
        input.new_str = textToInsert;
        break;

      case 'create':
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
          void showLoggedMessage(CHANNEL, 'File content is required');
          return;
        }

        input.path = newFilePath;
        input.file_text = fileContent;
        break;

      case 'undo_edit':
        // No additional input needed
        break;

      default:
        void showLoggedMessage(CHANNEL, `Unsupported command: ${command}`);
        return;
    }

    logger.info(
      CHANNEL,
      `Executing text editor tool with input: ${JSON.stringify(input)}`,
    );

    const result = await textEditorTool.call(input);

    if (result.status === 'error') {
      await showLoggedErrorMessage(
        CHANNEL,
        'Error from text editor tool',
        result.error,
      );
    } else {
      logger.info(CHANNEL, `Success from text editor tool: ${result.output}`);

      const outputDoc = await vscode.workspace.openTextDocument({
        content: result.output || 'No output',
        language: 'text',
      });

      await vscode.window.showTextDocument(outputDoc, {
        viewColumn: vscode.ViewColumn.Beside,
      });
    }
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'Error in testTextEditor command',
      err,
    );
  }
}
