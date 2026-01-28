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
 * Retrieve linter diagnostics for a file.
 * Triggers a LaTeX build first for .tex files to refresh diagnostics.
 */
export async function getLinterMessages(
  filePath: string,
): Promise<vscode.Diagnostic[]> {
  const fileUri = vscode.Uri.file(WorkspaceFS.fullPath(filePath));

  if (isTexFile(filePath)) {
    await triggerLaTeXBuild(filePath, fileUri);
  }

  return vscode.languages.getDiagnostics(fileUri);
}

/**
 * Trigger a LaTeX build and wait for diagnostics to update.
 */
async function triggerLaTeXBuild(
  filePath: string,
  fileUri: vscode.Uri,
): Promise<void> {
  await ensureFileOpen(filePath, { preserveFocus: true, save: true });

  const diagnosticsWait = waitForDiagnosticsChange(
    fileUri,
    DIAGNOSTIC_UPDATE_TIMEOUT_MS,
  );

  try {
    await vscode.commands.executeCommand('latex-workshop.build', fileUri);
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to trigger LaTeX build: ${toErrorMessage(err)}`,
    );
  } finally {
    await diagnosticsWait;
  }
}
