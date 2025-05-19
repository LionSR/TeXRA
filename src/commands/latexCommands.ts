// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getRelativePath } from '../utils/workspaceFileUtils';
import { sleep } from '../utils/timeUtils';
import {
  applyReplacements,
  getAllReplacements,
  getAllReplacementsRegex,
} from '../replacement/replacementUtils';

// Local imports - latex utils
import { runLatexIndent } from '../latex/latexindent';
import { getTeXCount } from '../latex/texcount';

// Local imports - commands
import { fileSelectionCommands } from './fileSelectionCommands';

// Local imports - housekeeping
import { runIndentTeX } from '../housekeeping';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export function registerLatexCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.indentCurrentTeX',
      handleIndentCurrentTeX,
    ),
    vscode.commands.registerCommand('texra.getTeXCount', handleGetTeXCount),
    vscode.commands.registerCommand('texra.indentTeX', runIndentTeX),
    vscode.commands.registerCommand(
      'texra.applyReplacements',
      handleApplyReplacements,
    ),
  );
}

async function handleApplyReplacements(): Promise<void> {
  try {
    // Get active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active text editor found');
      return;
    }
    if (editor?.document.isDirty) {
      await editor.document.save();
    }

    // Get document content
    const document = editor.document;
    const text = document.getText();

    // Apply replacements
    let processedText = text;
    processedText = applyReplacements(
      processedText,
      getAllReplacements(),
    ).trim();
    processedText = applyReplacements(
      processedText,
      getAllReplacementsRegex(),
    ).trim();
    processedText = applyReplacements(
      processedText,
      getAllReplacements(),
    ).trim();

    // Update document content
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(text.length),
    );

    await editor.edit((editBuilder) => {
      editBuilder.replace(fullRange, processedText);
    });

    vscode.window.showInformationMessage(
      'LaTeX replacements applied successfully',
    );
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error applying replacements: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error applying LaTeX replacements');
  }
}

async function handleIndentCurrentTeX(): Promise<void> {
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

    logger.debug(CHANNEL, `Indenting LaTeX file: ${relativePath}`);

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
      await sleep(100); // Small delay to ensure file is written
      vscode.window.showInformationMessage('LaTeX file indented successfully');
    } else {
      vscode.window.showErrorMessage('Failed to indent LaTeX file');
    }
  } catch (err) {
    logger.error(CHANNEL, `Error in indentTeX command: ${err}`);
    vscode.window.showErrorMessage('Error indenting LaTeX file');
  }
}

async function handleGetTeXCount(): Promise<void> {
  try {
    // Get active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Please open a LaTeX file first');
      return;
    }

    // Check if it's a LaTeX file
    if (!editor.document.fileName.toLowerCase().endsWith('.tex')) {
      vscode.window.showWarningMessage(
        'This command only works with LaTeX files',
      );
      return;
    }

    const filePath = getRelativePath(editor.document.fileName);
    logger.debug(CHANNEL, `Getting tex count for: ${filePath}`);

    // Ask if user wants to merge included files
    const mergeOption = await vscode.window.showQuickPick(
      [
        { label: 'Count main file only', value: false },
        { label: 'Merge included files', value: true },
      ],
      {
        placeHolder: 'Count options',
        canPickMany: false,
      },
    );

    if (!mergeOption) {
      return;
    }

    // Show progress indicator
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Counting LaTeX Document',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Running texcount...' });

        const result = await getTeXCount(filePath, mergeOption.value, CHANNEL);

        if (result) {
          // Extract key statistics using regex
          const wordMatch = result.match(/Words in text:\s*(\d+)/);
          const headerMatch = result.match(/Words in headers:\s*(\d+)/);
          const captionMatch = result.match(/Words in float captions:\s*(\d+)/);
          const mathInlineMatch = result.match(
            /Number of inline math:\s*(\d+)/,
          );
          const mathDisplayMatch = result.match(
            /Number of displayed math:\s*(\d+)/,
          );

          const stats = [
            wordMatch ? `Text: ${wordMatch[1]} words` : null,
            headerMatch ? `Headers: ${headerMatch[1]}` : null,
            captionMatch ? `Captions: ${captionMatch[1]}` : null,
            mathInlineMatch ? `Inline math: ${mathInlineMatch[1]}` : null,
            mathDisplayMatch ? `Display math: ${mathDisplayMatch[1]}` : null,
          ]
            .filter((item): item is string => item != null) // Type guard to remove nulls
            .map((label) => ({ label })); // Convert strings to QuickPickItems

          // Show results in QuickPick
          await vscode.window.showQuickPick(stats, {
            placeHolder: 'TeXCount Results (press Esc to dismiss)',
            canPickMany: false,
          });
        } else {
          vscode.window.showErrorMessage('Failed to get tex count');
        }
      },
    );
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in getTeXCount command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error getting tex count');
  }
}

export const latexCommands = {
  handleIndentCurrentTeX,
  handleGetTeXCount,
  runIndentTeX,
  handleApplyReplacements,
};
