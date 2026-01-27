// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import { isTexFile } from '@common/files/fileTypeUtils';
import { ensureFileOpen } from '@frontend/vscode/vscodeEditor';
import { waitForDiagnosticsChange } from '@frontend/vscode/vscodeDiagnostics';

// Local imports
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'LinterUtils';

const DIAGNOSTIC_UPDATE_TIMEOUT_MS = 7500;

/**
 * Trigger a LaTeX build for a specific file.
 * Internal helper - waits for diagnostics to update after build.
 */
async function triggerLaTeXBuild(filePath: string): Promise<void> {
  const fullPath = WorkspaceFS.fullPath(filePath);
  const fileUri = vscode.Uri.file(fullPath);

  await ensureFileOpen(filePath, { preserveFocus: true, save: true });

  const diagnosticsWait = waitForDiagnosticsChange(
    fileUri,
    DIAGNOSTIC_UPDATE_TIMEOUT_MS,
  );

  try {
    await vscode.commands.executeCommand('latex-workshop.build', fileUri);
  } finally {
    await diagnosticsWait;
  }
}

/**
 * Retrieve linter diagnostics for a file.
 * Triggers a LaTeX build first for .tex files to refresh diagnostics.
 */
export async function getLinterMessages(
  filePath: string,
): Promise<vscode.Diagnostic[]> {
  if (isTexFile(filePath)) {
    try {
      await triggerLaTeXBuild(filePath);
    } catch (err) {
      logger.warn(
        CHANNEL,
        `Failed to trigger LaTeX build: ${toErrorMessage(err)}`,
      );
    }
  }

  const fullPath = WorkspaceFS.fullPath(filePath);
  const fileUri = vscode.Uri.file(fullPath);
  return vscode.languages.getDiagnostics(fileUri);
}
