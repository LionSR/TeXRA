// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import { waitForDiagnosticsChange } from '@common/vscodeDiagnostics';

// Local imports - log
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'LinterUtils';
logger.initialize(CHANNEL);

const DIAGNOSTIC_UPDATE_TIMEOUT_MS = 7500;

/**
 * Trigger a LaTeX build for a specific file
 * @param filePath Path to the file (relative to workspace)
 * @returns Promise resolving when build is triggered
 */
export async function triggerLaTeXBuild(filePath: string): Promise<void> {
  try {
    if (!filePath.toLowerCase().endsWith('.tex')) {
      return; // Only trigger for TeX files
    }

    // Get the full path and create URI for the specific file
    const fullPath = WorkspaceFS.fullPath(filePath);
    const fileUri = vscode.Uri.file(fullPath);

    // First, make sure the file is open in an editor
    let editor: vscode.TextEditor | undefined;
    try {
      // Try to find if file is already open
      editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.fsPath === fullPath,
      );

      // If not open, open it
      if (!editor) {
        const document = await vscode.workspace.openTextDocument(fileUri);
        editor = await vscode.window.showTextDocument(document, {
          preview: false,
          preserveFocus: true,
        });
        logger.debug(CHANNEL, `Opened file in editor: ${filePath}`);
      }

      // Make sure the file is saved
      if (editor.document.isDirty) {
        await editor.document.save();
        logger.debug(CHANNEL, `Saved file: ${filePath}`);
      }
    } catch (openErr) {
      logger.warn(
        CHANNEL,
        `Could not open file in editor: ${toErrorMessage(openErr)}`,
      );
      // Continue anyway - we'll still try to trigger the build
    }

    logger.debug(
      CHANNEL,
      `Triggering LaTeX build for ${filePath} to refresh linter diagnostics`,
    );

    // Start listening for diagnostics updates before triggering the build
    // to ensure we don't miss the event if the build completes quickly
    const diagnosticsWait = waitForDiagnosticsChange(
      fileUri,
      DIAGNOSTIC_UPDATE_TIMEOUT_MS,
    );

    try {
      await vscode.commands.executeCommand('latex-workshop.build', fileUri);
    } finally {
      // Wait for diagnostics to update (or timeout)
      await diagnosticsWait;
    }
  } catch (buildErr) {
    logger.warn(
      CHANNEL,
      `Failed to trigger LaTeX build: ${toErrorMessage(buildErr)}`,
    );
    // Continue anyway, as we'll use whatever diagnostics are available
  }
}

/**
 * Get linter diagnostics for a specific file
 * @param filePath Path to the file (relative to workspace)
 * @returns Array of diagnostic information
 */
export function getDiagnostics(filePath: string): vscode.Diagnostic[] {
  try {
    // Convert relative path to absolute path
    const fullPath = WorkspaceFS.fullPath(filePath);

    // Convert to Uri to match diagnostics format
    const fileUri = vscode.Uri.file(fullPath);

    // Get all diagnostics for the file from VS Code
    const diagnostics = vscode.languages.getDiagnostics(fileUri);

    logger.debug(
      CHANNEL,
      `Retrieved ${diagnostics.length} diagnostics for ${filePath}`,
    );
    return diagnostics;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error getting diagnostics for ${filePath}: ${toErrorMessage(err)}`,
    );
    return [];
  }
}

/**
 * Retrieve linter diagnostics for a file.
 * Triggers a LaTeX build first for .tex files to refresh diagnostics.
 */
export async function getLinterMessages(
  filePath: string,
): Promise<vscode.Diagnostic[]> {
  if (filePath.toLowerCase().endsWith('.tex')) {
    await triggerLaTeXBuild(filePath);
  }
  return getDiagnostics(filePath);
}
