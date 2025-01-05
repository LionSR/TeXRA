// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath } from '../utils/fileUtils';

// Local imports - latex utils
import { runLatexdiff, runLatexdiffvc } from '../latex/latexdiff';

// Local imports - housekeeping
import {
  runPackLatexdiffvc,
  runPackLatexdiffvcMultiple,
  runCleanLatexdiffvc,
  runCleanLatexdiffvcMultiple,
} from '../housekeeping';

const CHANNEL = 'Latexdiff';

export function registerLatexdiffCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.latexdiff', handleLatexdiff),
    vscode.commands.registerCommand('coauthor.latexdiffvc', handleLatexdiffvc),
    vscode.commands.registerCommand(
      'coauthor.packLatexdiffvc',
      handlePackLatexdiffvc,
    ),
    vscode.commands.registerCommand(
      'coauthor.packLatexdiffvcMultiple',
      handlePackLatexdiffvcMultiple,
    ),
    vscode.commands.registerCommand(
      'coauthor.cleanLatexdiffvc',
      handleCleanLatexdiffvc,
    ),
    vscode.commands.registerCommand(
      'coauthor.cleanLatexdiffvcMultiple',
      handleCleanLatexdiffvcMultiple,
    ),
  );
}

async function handleLatexdiff(
  inputFile: string,
  baseFile: string,
  editedFile: string,
) {
  const fileToUse = baseFile || inputFile;
  try {
    // Get the diff filename from runLatexdiff
    const diffFileName = await runLatexdiff(fileToUse, editedFile);
    if (!diffFileName) {
      throw new Error('Failed to generate diff file');
    }

    // Open the diff file and build it
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Use the returned diff filename to construct the full path
    const fullPath = vscode.Uri.file(
      path.join(workspacePath, path.dirname(fileToUse), diffFileName),
    );

    // Verify the file exists
    try {
      await vscode.workspace.fs.stat(fullPath);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
        throw new Error(
          `Diff file could not be found. Expected path: ${fullPath.fsPath}`,
        );
      }
      throw error;
    }

    const doc = await vscode.window.showTextDocument(fullPath);
    await vscode.window.showTextDocument(doc.document, {
      preview: false,
      preserveFocus: true,
    });
    await vscode.commands.executeCommand(
      'workbench.view.extension.latex-workshop-activitybar',
    );
    await vscode.commands.executeCommand('latex-workshop.build');

    // Wait for build to complete before viewing
    setTimeout(async () => {
      await vscode.commands.executeCommand('latex-workshop.view');
    }, 5000);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error creating LaTeX diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  const fileToUse = baseFile || inputFile;
  try {
    // Get the diff filename from runLatexdiffvc
    const diffFileName = await runLatexdiffvc(fileToUse, commitHash);
    if (!diffFileName) {
      throw new Error('Failed to generate diff file');
    }

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Use the returned diff filename to construct the full path
    const fullPath = vscode.Uri.file(
      path.join(workspacePath, path.dirname(fileToUse), diffFileName),
    );

    // Verify the file exists
    try {
      await vscode.workspace.fs.stat(fullPath);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
        throw new Error(
          `Diff file could not be found. Expected path: ${fullPath.fsPath}`,
        );
      }
      throw error;
    }

    const doc = await vscode.window.showTextDocument(fullPath);
    await vscode.window.showTextDocument(doc.document, {
      preview: false,
      preserveFocus: true,
    });
    await vscode.commands.executeCommand('latex-workshop.build');

    // Wait for build to complete before viewing
    setTimeout(async () => {
      await vscode.commands.executeCommand('latex-workshop.view');
    }, 5000);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error creating LaTeX diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handlePackLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
  clean: boolean,
) {
  logger.debug(
    CHANNEL,
    `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}, clean=${clean}`,
  );
  const fileToUse = baseFile || inputFile;
  await runPackLatexdiffvc(fileToUse, commitHash, clean);
}

async function handlePackLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean,
) {
  logger.debug(
    CHANNEL,
    `Command called with: commitHash=${commitHash}, clean=${clean}`,
  );
  logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
  await runPackLatexdiffvcMultiple(inputFiles, commitHash, clean);
}

async function handleCleanLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  logger.debug(
    CHANNEL,
    `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}`,
  );
  const fileToUse = baseFile || inputFile;
  await runCleanLatexdiffvc(fileToUse, commitHash);
}

async function handleCleanLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
) {
  logger.debug(CHANNEL, `Command called with: commitHash=${commitHash}`);
  logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
  await runCleanLatexdiffvcMultiple(inputFiles, commitHash);
}

export const latexdiffCommands = {
  handleLatexdiff,
  handleLatexdiffvc,
  handlePackLatexdiffvc,
  handlePackLatexdiffvcMultiple,
  handleCleanLatexdiffvc,
  handleCleanLatexdiffvcMultiple,
};
