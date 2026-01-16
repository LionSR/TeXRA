// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import { ensureFileOpen } from '@common/vscodeEditor';
import { waitForDiagnosticsChange } from '@common/vscodeDiagnostics';

// Local imports
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'LinterUtils';

const DIAGNOSTIC_UPDATE_TIMEOUT_MS = 7500;

/**
 * Trigger a LaTeX build for a specific file
 * @param filePath Path to the file (relative to workspace)
 * @returns Promise resolving when build is triggered
 */
export async function triggerLaTeXBuild(filePath: string): Promise<void> {
  if (!filePath.toLowerCase().endsWith('.tex')) {
    return;
  }

  try {
    const fullPath = WorkspaceFS.fullPath(filePath);
    const fileUri = vscode.Uri.file(fullPath);

    // Ensure file is open and saved
    await ensureFileOpen(filePath, { preserveFocus: true, save: true });

    // Start listening for diagnostics updates before triggering the build
    const diagnosticsWait = waitForDiagnosticsChange(
      fileUri,
      DIAGNOSTIC_UPDATE_TIMEOUT_MS,
    );

    try {
      await vscode.commands.executeCommand('latex-workshop.build', fileUri);
    } finally {
      await diagnosticsWait;
    }
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to trigger LaTeX build: ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Get linter diagnostics for a specific file
 * @param filePath Path to the file (relative to workspace)
 * @returns Array of diagnostic information
 */
export function getDiagnostics(filePath: string): vscode.Diagnostic[] {
  const fullPath = WorkspaceFS.fullPath(filePath);
  const fileUri = vscode.Uri.file(fullPath);
  return vscode.languages.getDiagnostics(fileUri);
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
