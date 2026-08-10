// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { isTexFile } from '@common/files/fileTypeUtils';
import { invokeLatexWorkshopBuild } from '@frontend/latex/openBuild';
import { ensureFileOpen } from '@frontend/vscode/vscodeEditor';
import { waitForDiagnosticsChange } from '@frontend/vscode/vscodeDiagnostics';

// Local imports
import { WorkspaceFS } from '@utils/files/workspaceFS';

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
    await invokeLatexWorkshopBuild(
      fileUri,
      CHANNEL,
      'Failed to trigger LaTeX build',
    );
  } finally {
    await diagnosticsWait;
  }
}
