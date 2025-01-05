// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath } from '../utils/fileUtils';

// Local imports - latex utils
import { runLatexDiff, runLatexDiffVC } from '../latex/latexdiff';

// Local imports - housekeeping
import {
  runPackLatexDiffVC,
  runPackLatexDiffVCMultiple,
  runCleanLatexDiffVC,
  runCleanLatexDiffVCMultiple,
} from '../housekeeping';

const CHANNEL = 'LatexDiff';

export function registerLatexDiffCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.latexdiff', handleLatexDiff),
    vscode.commands.registerCommand('coauthor.latexdiffVC', handleLatexDiffVC),
    vscode.commands.registerCommand(
      'coauthor.packLatexDiffVC',
      handlePackLatexDiffVC,
    ),
    vscode.commands.registerCommand(
      'coauthor.packLatexDiffVCMultiple',
      handlePackLatexDiffVCMultiple,
    ),
    vscode.commands.registerCommand(
      'coauthor.cleanLatexDiffVC',
      handleCleanLatexDiffVC,
    ),
    vscode.commands.registerCommand(
      'coauthor.cleanLatexDiffVCMultiple',
      handleCleanLatexDiffVCMultiple,
    ),
  );
}

async function handleLatexDiff(
  inputFile: string,
  baseFile: string,
  editedFile: string,
) {
  const fileToUse = baseFile || inputFile;
  try {
    // Get the diff filename from runLatexDiff
    const diffFileName = await runLatexDiff(fileToUse, editedFile);
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

async function handleLatexDiffVC(
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  const fileToUse = baseFile || inputFile;
  try {
    // Get the diff filename from runLatexDiffVC
    const diffFileName = await runLatexDiffVC(fileToUse, commitHash);
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

async function handlePackLatexDiffVC(
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
  await runPackLatexDiffVC(fileToUse, commitHash, clean);
}

async function handlePackLatexDiffVCMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean,
) {
  logger.debug(
    CHANNEL,
    `Command called with: commitHash=${commitHash}, clean=${clean}`,
  );
  logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
  await runPackLatexDiffVCMultiple(inputFiles, commitHash, clean);
}

async function handleCleanLatexDiffVC(
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  logger.debug(
    CHANNEL,
    `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}`,
  );
  const fileToUse = baseFile || inputFile;
  await runCleanLatexDiffVC(fileToUse, commitHash);
}

async function handleCleanLatexDiffVCMultiple(
  inputFiles: string[],
  commitHash: string,
) {
  logger.debug(CHANNEL, `Command called with: commitHash=${commitHash}`);
  logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
  await runCleanLatexDiffVCMultiple(inputFiles, commitHash);
}

export const latexdiffCommands = {
  handleLatexDiff,
  handleLatexDiffVC,
  handlePackLatexDiffVC,
  handlePackLatexDiffVCMultiple,
  handleCleanLatexDiffVC,
  handleCleanLatexDiffVCMultiple,
};
