/**
 * VS Code integration with the Lean 4 extension.
 *
 * Provides access to Lean 4 diagnostics and goal state via VS Code's built-in
 * language APIs and the Lean 4 extension's exported API.
 */

import * as vscode from 'vscode';

import { WorkspaceFS } from '@utils/files';

// ============================================================================
// Types
// ============================================================================

/** Response from $/lean/plainGoal LSP request */
export interface PlainGoal {
  goals: string[];
  rendered: string;
}

/** Lean 4 extension's client provider interface */
interface LeanClient {
  isRunning(): boolean;
  sendRequest(method: string, params: unknown): Promise<unknown>;
}

interface LeanClientProvider {
  findClient(uri: vscode.Uri): LeanClient | undefined;
}

interface Lean4EnabledFeatures {
  clientProvider: LeanClientProvider;
}

interface Lean4ExtensionApi {
  lean4EnabledFeatures: Promise<Lean4EnabledFeatures>;
}

/**
 * Get diagnostics for a Lean file using VS Code's diagnostics API.
 * This returns diagnostics from the Lean 4 extension's LSP.
 */
export function getDiagnostics(filePath: string): vscode.Diagnostic[] {
  const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
  const directLookup = vscode.languages.getDiagnostics(uri);
  if (directLookup.length > 0) {
    return directLookup;
  }

  // Fallback: search by path in case URI format differs
  return findDiagnosticsByPath(uri.fsPath);
}

/** Find diagnostics by matching file path (case-insensitive). */
function findDiagnosticsByPath(targetPath: string): vscode.Diagnostic[] {
  const normalizedTarget = targetPath.toLowerCase();
  for (const [diagUri, diags] of vscode.languages.getDiagnostics()) {
    if (diagUri.fsPath.toLowerCase() === normalizedTarget && diags.length > 0) {
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

// ============================================================================
// Goal State (via Lean 4 Extension API)
// ============================================================================

const LEAN4_EXTENSION_ID = 'leanprover.lean4';

/**
 * Get the Lean 4 extension's client provider.
 * Returns null if the extension is not installed or not ready.
 */
async function getClientProvider(): Promise<LeanClientProvider | null> {
  const lean4Ext = vscode.extensions.getExtension<Lean4ExtensionApi>(LEAN4_EXTENSION_ID);
  if (!lean4Ext) return null;

  const api = await lean4Ext.activate();
  const features = await api.lean4EnabledFeatures;
  return features.clientProvider;
}

/**
 * Get the proof goal state at a specific position in a Lean file.
 *
 * Uses the Lean 4 extension's LSP client to send a $/lean/plainGoal request.
 * Opens the file first to ensure the LSP server has processed it.
 *
 * @param filePath - Path to the .lean file
 * @param line - 0-indexed line number
 * @param column - 0-indexed column number
 * @returns Goal state or null if unavailable
 */
export async function getGoalState(
  filePath: string,
  line: number,
  column: number,
): Promise<PlainGoal | null> {
  const clientProvider = await getClientProvider();
  if (!clientProvider) return null;

  const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));

  // Open the document to ensure the LSP server has processed it
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preserveFocus: true });
  } catch {
    return null;
  }

  const client = clientProvider.findClient(uri);
  if (!client?.isRunning()) return null;

  const result = await client.sendRequest('$/lean/plainGoal', {
    textDocument: { uri: uri.toString() },
    position: { line, character: column },
  });

  return result as PlainGoal | null;
}
