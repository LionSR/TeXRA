// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath } from '../utils/fileUtils';

// Local imports - latex utils
import {
  runLatexdiff,
  runLatexdiffvc,
  ensureLatexdiffInstalled,
  ensureLatexdiffVcInstalled,
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

    // Get the diff filename from runLatexdiff
    const diffFileName = await runLatexdiff(
      fileToUse,
      editedFile,
      '_diff',
      false,
      CHANNEL,
    );
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
    } catch (err) {
      if (
        err instanceof vscode.FileSystemError &&
        err.code === 'FileNotFound'
      ) {
        throw new Error(
          `Diff file could not be found. Expected path: ${fullPath.fsPath}`,
        );
      }
      throw err;
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

    // Get the diff filename from runLatexdiffvc
    const diffFileName = await runLatexdiffvc(fileToUse, commitHash, CHANNEL);
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

    // do we have to use fs.stat? cannot we use something like fileExists?

    // Verify the file exists
    try {
      await vscode.workspace.fs.stat(fullPath);
    } catch (err) {
      if (
        err instanceof vscode.FileSystemError &&
        err.code === 'FileNotFound'
      ) {
        throw new Error(
          `Diff file could not be found. Expected path: ${fullPath.fsPath}`,
        );
      }
      throw err;
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
