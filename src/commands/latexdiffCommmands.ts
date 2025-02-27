// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath } from '../utils/workspaceFileUtils';
import { fileExists } from '../utils/workspaceFileUtils';

// Local imports - latex utils
import {
  runLatexdiff,
  runLatexdiffvc,
  ensureLatexdiffInstalled,
  ensureLatexdiffVcInstalled,
  LaTeXdiffResult,
  LaTeXdiffMultipleResult,
} from '../latex/latexdiff';

// Local imports - housekeeping
import {
  runPackLatexdiffvc,
  runPackLatexdiffvcMultiple,
  runCleanLatexdiffvc,
  runCleanLatexdiffvcMultiple,
} from '../housekeeping';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

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
    // Check if latexdiff is installed
    if (!(await ensureLatexdiffInstalled())) {
      return;
    }

    // Get the result from runLatexdiff
    const result = await runLatexdiff(fileToUse, editedFile, '_diff', false);

    if (!result.success || !result.diffFileName) {
      throw new Error(result.message || 'Failed to generate diff file');
    }

    // Open the diff file and build it
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Use the returned diff filename to construct the full path
    const fullPath = vscode.Uri.file(
      path.join(workspacePath, path.dirname(fileToUse), result.diffFileName),
    );

    // Verify the file exists using fileExists utility
    const filePathRelative = path.join(
      path.dirname(fileToUse),
      result.diffFileName,
    );
    if (!(await fileExists(filePathRelative))) {
      vscode.window.showErrorMessage(
        `Diff file could not be found. Expected path: ${fullPath.fsPath}`,
      );
      return;
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
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error creating LaTeX diff: ${err instanceof Error ? err.message : String(err)}`,
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
    // Check if latexdiff-vc is installed
    if (!(await ensureLatexdiffVcInstalled())) {
      return;
    }

    // Get the result from runLatexdiffvc
    const result = await runLatexdiffvc(fileToUse, commitHash);

    if (!result.success || !result.diffFileName) {
      throw new Error(result.message || 'Failed to generate diff file');
    }

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Use the returned diff filename to construct the full path
    const fullPath = vscode.Uri.file(
      path.join(workspacePath, path.dirname(fileToUse), result.diffFileName),
    );

    // Verify the file exists using fileExists utility
    const filePathRelative = path.join(
      path.dirname(fileToUse),
      result.diffFileName,
    );
    if (!(await fileExists(filePathRelative))) {
      vscode.window.showErrorMessage(
        `Diff file could not be found. Expected path: ${fullPath.fsPath}`,
      );
      return;
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
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error creating LaTeX diff: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handlePackLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
  clean: boolean,
) {
  try {
    // Check if latexdiff-vc is installed
    if (!(await ensureLatexdiffVcInstalled())) {
      return;
    }

    logger.debug(
      CHANNEL,
      `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}, clean=${clean}`,
    );
    const fileToUse = baseFile || inputFile;
    await runPackLatexdiffvc(fileToUse, commitHash, clean);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error packing LaTeX diff: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handlePackLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  clean: boolean,
) {
  try {
    // Check if latexdiff-vc is installed
    if (!(await ensureLatexdiffVcInstalled())) {
      return;
    }

    logger.debug(
      CHANNEL,
      `Command called with: commitHash=${commitHash}, clean=${clean}`,
    );
    logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
    await runPackLatexdiffvcMultiple(inputFiles, commitHash, clean);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error packing LaTeX diffs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleCleanLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
) {
  try {
    // Check if latexdiff-vc is installed
    if (!(await ensureLatexdiffVcInstalled())) {
      return;
    }

    logger.debug(
      CHANNEL,
      `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}`,
    );
    const fileToUse = baseFile || inputFile;
    await runCleanLatexdiffvc(fileToUse, commitHash);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error cleaning LaTeX diff: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleCleanLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
) {
  try {
    // Check if latexdiff-vc is installed
    if (!(await ensureLatexdiffVcInstalled())) {
      return;
    }

    logger.debug(CHANNEL, `Command called with: commitHash=${commitHash}`);
    logger.debug(CHANNEL, `Input files: ${inputFiles.join(', ')}`);
    await runCleanLatexdiffvcMultiple(inputFiles, commitHash);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error cleaning LaTeX diffs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const latexdiffCommands = {
  handleLatexdiff,
  handleLatexdiffvc,
  handlePackLatexdiffvc,
  handlePackLatexdiffvcMultiple,
  handleCleanLatexdiffvc,
  handleCleanLatexdiffvcMultiple,
};
