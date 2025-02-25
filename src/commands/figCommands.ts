// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getRelativePath, getWorkspacePath } from '../utils/workspaceFileUtils';

// Local imports - latex utils
import { extractFigurePathsFromLatex } from '../latex/extractFigure';
import {
  extractTikzPicturesWithLabels,
  extractAndCompileTikzPicturesWithLabels,
} from '../latex/tikzpicture';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

export function registerFigureCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.extractFigurePaths',
      handleExtractFigurePaths,
    ),
    vscode.commands.registerCommand(
      'coauthor.extractTikzFigures',
      handleExtractTikzFigures,
    ),
    vscode.commands.registerCommand(
      'coauthor.compileTikzFigures',
      handleCompileTikzFigures,
    ),
  );
}

async function handleExtractFigurePaths(): Promise<void> {
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
    logger.debug(CHANNEL, `Processing LaTeX file: ${filePath}`);

    // Extract figure paths
    const figurePaths = await extractFigurePathsFromLatex(filePath);

    if (figurePaths.length > 0) {
      // Show results in QuickPick
      const selected = await vscode.window.showQuickPick(figurePaths, {
        placeHolder: 'Found figures (select to copy path)',
        canPickMany: false,
      });

      if (selected) {
        await vscode.env.clipboard.writeText(selected);
        vscode.window.showInformationMessage(`Copied figure path: ${selected}`);
      }
    } else {
      vscode.window.showInformationMessage(
        'No figures found in the current file',
      );
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in extractFigurePaths command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error extracting figure paths');
  }
}

async function handleExtractTikzFigures(): Promise<void> {
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
    logger.debug(
      CHANNEL,
      `Processing LaTeX file for TikZ figures: ${filePath}`,
    );

    // Extract TikZ pictures with labels
    const labeledTikzPictures = await extractTikzPicturesWithLabels(filePath);

    if (labeledTikzPictures.length > 0) {
      // Create QuickPick items from the labels
      const items = labeledTikzPictures.map(
        ([label, tikzpicturess]: [string, string[]]) => ({
          label: `${label} (${tikzpicturess.length} TikZ picture${tikzpicturess.length > 1 ? 's' : ''})`,
          description: `Figure with label: ${label}`,
          detail: tikzpicturess[0].substring(0, 100) + '...', // Show first 100 chars of first TikZ picture
        }),
      );

      // Show results in QuickPick
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Found TikZ figures (select to copy label)',
        canPickMany: false,
      });

      if (selected) {
        const label = selected.label.split(' (')[0]; // Extract just the label part
        await vscode.env.clipboard.writeText(label);
        vscode.window.showInformationMessage(`Copied figure label: ${label}`);
      }
    } else {
      vscode.window.showInformationMessage(
        'No TikZ figures found in the current file',
      );
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in extractTikzFigures command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error extracting TikZ figures');
  }
}

async function handleCompileTikzFigures(): Promise<void> {
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
    logger.debug(
      CHANNEL,
      `Processing LaTeX file for TikZ compilation: ${filePath}`,
    );

    // Show progress indicator
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Compiling TikZ Figures',
        cancellable: false,
      },
      async (progress) => {
        progress.report({
          message: 'Extracting and compiling TikZ pictures...',
        });

        // Extract and compile TikZ pictures
        const compiledFiles =
          await extractAndCompileTikzPicturesWithLabels(filePath);

        if (compiledFiles.length > 0) {
          // Create QuickPick items from the compiled files
          const items = compiledFiles.map((filePath: string) => ({
            label: path.basename(filePath),
            description: filePath,
            file: filePath,
          }));

          // Show results in QuickPick
          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Compiled TikZ figures (select to open)',
            canPickMany: false,
          });

          if (selected) {
            // Open the selected PDF
            const uri = vscode.Uri.file(
              path.join(getWorkspacePath() || '', selected.file),
            );
            await vscode.commands.executeCommand('vscode.open', uri);
          }

          vscode.window.showInformationMessage(
            `Successfully compiled ${compiledFiles.length} TikZ figure${compiledFiles.length > 1 ? 's' : ''}`,
          );
        } else {
          vscode.window.showInformationMessage(
            'No TikZ figures found to compile',
          );
        }
      },
    );
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in compileTikzFigures command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error compiling TikZ figures');
  }
}

export const figureCommands = {
  handleExtractFigurePaths,
  handleExtractTikzFigures,
  handleCompileTikzFigures,
};
