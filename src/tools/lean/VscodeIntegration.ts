/**
 * VS Code integration with the Lean 4 extension.
 *
 * Provides access to Lean 4 diagnostics via VS Code's built-in language APIs.
 */

import * as vscode from 'vscode';

import { WorkspaceFS } from '@utils/files';

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
  for (const [diagUri, diags] of vscode.languages.getDiagnostics()) {
    if (diagUri.fsPath.toLowerCase() === resolvedPath && diags.length > 0) {
      return diags;
    }
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
  } catch {
    return false;
  }
}
