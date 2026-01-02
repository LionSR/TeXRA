// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - errors
import { showLoggedErrorMessage, showLoggedInfoMessage } from '@common/errors';
import { withLaTeXGuard } from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';
import { pathToLocation } from '@utils/files';
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
    await withLaTeXGuard(
      { channel: CHANNEL, action: 'extract figure paths' },
      async ({ relativePath: filePath }) => {
        logger.debug(CHANNEL, `Processing LaTeX file: ${filePath}`);

        // Extract figure paths
        const figurePaths = await extractFigurePathsFromLatex(
          pathToLocation(filePath),
        );

        if (figurePaths.length > 0) {
          // Show results in QuickPick
          const selected = await vscode.window.showQuickPick(figurePaths, {
            placeHolder: 'Found figures (select to copy path)',
            canPickMany: false,
          });

          if (selected) {
            await vscode.env.clipboard.writeText(selected);
            await showLoggedInfoMessage(
              CHANNEL,
              `Copied figure path: ${selected}`,
            );
          }
        } else {
          await showLoggedInfoMessage(
            CHANNEL,
            'No figures found in the current file',
          );
        }
      },
    );
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'extractFigurePaths command failed',
      err,
    );
  }
}

async function handleExtractTikzFigures(): Promise<void> {
  try {
    await withLaTeXGuard(
      { channel: CHANNEL, action: 'extract TikZ figures' },
      async ({ relativePath: filePath }) => {
        logger.debug(
          CHANNEL,
          `Processing LaTeX file for TikZ figures: ${filePath}`,
        );

        // Extract TikZ pictures with labels
        const labeledTikzPictures = await tikzPictureManager.extract(
          pathToLocation(filePath),
        );

        if (labeledTikzPictures.length > 0) {
          // Create QuickPick items from the labels
          const items = labeledTikzPictures.map(
            ([label, tikzpicturess]: [string, string[]]) => ({
              label: `${label} (${tikzpicturess.length} TikZ picture${tikzpicturess.length > 1 ? 's' : ''})`,
              description: `Figure with label: ${label}`,
              detail: `${tikzpicturess[0].substring(0, 100)}...`, // Show first 100 chars of first TikZ picture
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
            await showLoggedInfoMessage(
              CHANNEL,
              `Copied figure label: ${label}`,
            );
          }
        } else {
          await showLoggedInfoMessage(
            CHANNEL,
            'No TikZ figures found in the current file',
          );
        }
      },
    );
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'extractTikzFigures command failed',
      err,
    );
  }
}

async function handleCompileTikzFigures(): Promise<void> {
  try {
    await withLaTeXGuard(
      { channel: CHANNEL, action: 'compile TikZ figures' },
      async ({ relativePath: filePath }) => {
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
            const compiledFiles = await tikzPictureManager.compile(
              pathToLocation(filePath),
            );

            if (compiledFiles.length > 0) {
              // Create QuickPick items from the compiled files
              const items = compiledFiles.map((fileLocation) => ({
                label: path.basename(fileLocation.absolutePath),
                description: fileLocation.absolutePath,
                file: fileLocation.absolutePath,
              }));

              // Show results in QuickPick
              const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Compiled TikZ figures (select to open)',
                canPickMany: false,
              });

              if (selected) {
                // Open the selected PDF
                const uri = vscode.Uri.file(selected.file);
                await vscode.commands.executeCommand('vscode.open', uri);
              }

              await showLoggedInfoMessage(
                CHANNEL,
                `Successfully compiled ${compiledFiles.length} TikZ figure${compiledFiles.length > 1 ? 's' : ''}`,
              );
            } else {
              await showLoggedInfoMessage(
                CHANNEL,
                'No TikZ figures found to compile',
              );
            }
          },
        );
      },
    );
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'compileTikzFigures command failed',
      err,
    );
  }
}

export const figureCommands = {
  handleExtractFigurePaths,
  handleExtractTikzFigures,
  handleCompileTikzFigures,
};
