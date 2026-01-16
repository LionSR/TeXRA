/**
 * VS Code integration with the Lean 4 extension.
 *
 * Provides access to Lean 4 diagnostics via VS Code's built-in language APIs.
 */

import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

// ============================================================================
// Public API
// ============================================================================

/**
 * Get diagnostics for a Lean file using VS Code's diagnostics API.
 * This returns diagnostics from the Lean 4 extension's LSP.
 */
export function getDiagnostics(filePath: string): vscode.Diagnostic[] {
  const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
  const diagnostics = vscode.languages.getDiagnostics(uri);

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  // Fallback: search by path in case URI format differs
  const resolvedPath = uri.fsPath.toLowerCase();
  const allDiagnostics = vscode.languages.getDiagnostics();

  for (const [diagUri, diags] of allDiagnostics) {
    if (diagUri.fsPath.toLowerCase() === resolvedPath && diags.length > 0) {
      logger.debug(
        'Lean4',
        `Found diagnostics via path match: ${diagUri.toString()}`,
      );
      return diags;
    }
  }

  // Log available URIs for debugging when no match found
  const urisWithDiags = allDiagnostics
    .filter(([, d]) => d.length > 0)
    .map(([u]) => u.toString())
    .slice(0, 5);

  if (urisWithDiags.length > 0) {
    logger.debug(
      'Lean4',
      `No diagnostics for ${uri.toString()}. Available: ${urisWithDiags.join(', ')}`,
    );
  }

  return [];
}

/**
 * Restart the Lean file server to pick up changes in dependencies.
 * Call this after editing imported files or changing lakefile.
 */
export async function restartFileServer(filePath: string): Promise<boolean> {
  try {
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preserveFocus: true });
    await vscode.commands.executeCommand('lean4.restartFile');
    return true;
  } catch (error) {
    logger.debug('Lean4', `Failed to restart file server: ${error}`);
    return false;
  }
}
