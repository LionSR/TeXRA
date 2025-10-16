// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import {
  getActiveEditorWithGuards,
  type ActiveFileGuardFailureReason,
} from '@utils/editor/activeFileGuards';

// Local imports - latex utils
import { extractFigurePathsFromLatex } from '@latex/extractFigure';
import { tikzPictureManager } from '@latex/TikzPictureManager';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

export function registerFigureCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.extractFigurePaths',
      handleExtractFigurePaths,
    ),
    vscode.commands.registerCommand(
      'texra.extractTikzFigures',
      handleExtractTikzFigures,
    ),
    vscode.commands.registerCommand(
      'texra.compileTikzFigures',
      handleCompileTikzFigures,
    ),
  );
}

async function handleExtractFigurePaths(): Promise<void> {
  try {
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.tex'],
      resourceName: 'LaTeX',
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure('extract figure paths', guardResult.status);
      return;
    }

    const { relativePath: filePath } = guardResult;
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
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.tex'],
      resourceName: 'LaTeX',
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure('extract TikZ figures', guardResult.status);
      return;
    }

    const { relativePath: filePath } = guardResult;
    logger.debug(
      CHANNEL,
      `Processing LaTeX file for TikZ figures: ${filePath}`,
    );

    // Extract TikZ pictures with labels
    const labeledTikzPictures = await tikzPictureManager.extract(filePath);

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
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.tex'],
      resourceName: 'LaTeX',
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure('compile TikZ figures', guardResult.status);
      return;
    }

    const { relativePath: filePath } = guardResult;
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
        const compiledFiles = await tikzPictureManager.compile(filePath);

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
              path.join(WorkspaceFS.getPath() ?? '', selected.file),
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

function logGuardFailure(
  action: string,
  reason: ActiveFileGuardFailureReason,
): void {
  switch (reason) {
    case 'noEditor':
      logger.warn(CHANNEL, `Cannot ${action}: no active editor found.`);
      break;
    case 'unsupportedExtension':
      logger.warn(
        CHANNEL,
        `Cannot ${action}: active document is not a LaTeX file.`,
      );
      break;
    case 'saveFailed':
      logger.error(
        CHANNEL,
        `Cannot ${action}: failed to save LaTeX document before running command.`,
      );
      break;
  }
}

export const figureCommands = {
  handleExtractFigurePaths,
  handleExtractTikzFigures,
  handleCompileTikzFigures,
};
