/**
 * VS Code integration with the Lean 4 extension.
 *
 * Provides access to Lean 4 diagnostics and goal state via VS Code's built-in
 * language APIs and the Lean 4 extension's exported API.
 */

import * as vscode from 'vscode';
import { Hover } from 'vscode-languageserver-protocol';

import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { WorkspaceFS } from '@utils/files';

// ============================================================================
// Types
// ============================================================================

/** Response from $/lean/plainGoal LSP request */
export interface PlainGoal {
  goals: string[];
  rendered: string;
}

/**
 * ExtUri-compatible object for Lean 4 extension.
 * The Lean 4 extension expects objects with scheme, fsPath, and toString().
 */
function createExtUri(
  absolutePath: string,
): { scheme: 'file'; fsPath: string; toString: () => string } {
  const uri = vscode.Uri.file(absolutePath);
  return {
    scheme: 'file',
    fsPath: absolutePath,
    toString: () => uri.toString(),
  };
}

/** URI type expected by Lean 4 extension API */
type ExtUri = { scheme: 'file'; fsPath: string; toString: () => string };

/** Lean 4 extension's client provider interface */
interface LeanClient {
  isRunning(): boolean;
  isInFolderManagedByThisClient(uri: ExtUri): boolean;
  sendRequest(method: string, params: unknown): Promise<unknown>;
}

interface LeanClientProvider {
  findClient(uri: ExtUri): LeanClient | undefined;
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
 * Execute a VS Code command that requires a file to be open.
 * Opens the file first, then executes the command.
 */
export async function executeFileCommand(
  command: string,
  filePath: string,
): Promise<boolean> {
  try {
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preserveFocus: true });
    await vscode.commands.executeCommand(command);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// LSP Requests (via Lean 4 Extension API)
// ============================================================================

const LEAN4_EXTENSION_ID = 'leanprover.lean4';

/**
 * Prompt user to install Lean 4 extension if not already installed.
 * Used when Lean tools are invoked but the extension is not found.
 */
export async function promptLean4ExtensionInstall(): Promise<void> {
  await showInstructionWithSuppress(
    'lean4-install-tool',
    'Lean 4 extension is required for this operation. Install now?',
    [
      {
        title: 'Install',
        callback: async () => {
          await safeExecuteCommand(
            'workbench.extensions.installExtension',
            [LEAN4_EXTENSION_ID],
            'lean',
          );
        },
      },
    ],
  );
}

/**
 * Check if Lean 4 extension is installed.
 */
export function isLean4ExtensionInstalled(): boolean {
  return vscode.extensions.getExtension(LEAN4_EXTENSION_ID) !== undefined;
}

/**
 * Get the Lean 4 extension's client provider.
 * Returns null if the extension is not installed or not ready.
 * Prompts user to install the extension if not found.
 */
async function getClientProvider(): Promise<LeanClientProvider | null> {
  const lean4Ext =
    vscode.extensions.getExtension<Lean4ExtensionApi>(LEAN4_EXTENSION_ID);
  if (!lean4Ext) {
    // Prompt user to install the extension
    await promptLean4ExtensionInstall();
    return null;
  }

  const api = await lean4Ext.activate();
  const features = await api.lean4EnabledFeatures;
  return features.clientProvider;
}

/**
 * Send an LSP request at a specific position in a Lean file.
 * Opens the file first to ensure the LSP server has processed it.
 */
export interface LspResult<T> {
  data: T | null;
  error?: string;
}

/** Create an error result */
function errorResult<T>(error: string): LspResult<T> {
  return { data: null, error };
}

async function sendPositionRequest<T>(
  filePath: string,
  line: number,
  column: number,
  method: string,
): Promise<LspResult<T>> {
  const absolutePath = WorkspaceFS.toAbsolute(filePath);
  const extUri = createExtUri(absolutePath);
  const vscodeUri = vscode.Uri.file(absolutePath);

  // Get client provider
  const clientProvider = await getClientProvider().catch(() => null);
  if (!clientProvider) {
    return errorResult('Lean 4 extension not found or not activated');
  }

  // Open file in editor so LSP server has processed it
  try {
    const document = await vscode.workspace.openTextDocument(vscodeUri);
    await vscode.window.showTextDocument(document, { preserveFocus: true });
  } catch (e) {
    return errorResult(`Failed to open file ${absolutePath}: ${e}`);
  }

  // Find and validate Lean client
  let client: LeanClient | undefined;
  try {
    client = clientProvider.findClient(extUri);
  } catch {
    return errorResult(
      `Error finding Lean client for ${absolutePath}. Is this file in a Lean project?`,
    );
  }
  if (!client) {
    return errorResult(
      `No Lean client for ${absolutePath}. Is this file in a Lean project with a lakefile?`,
    );
  }
  if (!client.isRunning()) {
    return errorResult('Lean server not running. Try lean_project restart_server.');
  }

  // Send LSP request
  try {
    const params = {
      textDocument: { uri: extUri.toString() },
      position: { line, character: column },
    };
    const result = await client.sendRequest(method, params);
    return { data: result as T };
  } catch (e) {
    return errorResult(`LSP request ${method} failed: ${e}`);
  }
}

/**
 * Get the proof goal state at a specific position in a Lean file.
 * @param line - 0-indexed line number
 * @param column - 0-indexed column number
 */
export async function getGoalState(
  filePath: string,
  line: number,
  column: number,
): Promise<LspResult<PlainGoal>> {
  return sendPositionRequest<PlainGoal>(
    filePath,
    line,
    column,
    '$/lean/plainGoal',
  );
}

/** Response from $/lean/plainTermGoal LSP request */
export interface PlainTermGoal {
  goal: string;
}

/**
 * Get the expected type (term goal) at a specific position in a Lean file.
 * @param line - 0-indexed line number
 * @param column - 0-indexed column number
 */
export async function getTermGoal(
  filePath: string,
  line: number,
  column: number,
): Promise<LspResult<PlainTermGoal>> {
  return sendPositionRequest<PlainTermGoal>(
    filePath,
    line,
    column,
    '$/lean/plainTermGoal',
  );
}

/** Extract text value from hover contents (handles all LSP content formats) */
export function extractHoverText(contents: Hover['contents']): string | null {
  if (typeof contents === 'string') {
    return contents;
  }

  if (Array.isArray(contents)) {
    const texts = contents.map((item) => {
      if (typeof item === 'string') return item;
      if ('value' in item) return item.value;
      return null;
    });
    return texts.filter(Boolean).join('\n\n');
  }

  if ('value' in contents) {
    return contents.value;
  }

  return null;
}

/**
 * Get hover information (type + docs) at a specific position in a Lean file.
 * @param line - 0-indexed line number
 * @param column - 0-indexed column number
 */
export async function getHoverInfo(
  filePath: string,
  line: number,
  column: number,
): Promise<LspResult<Hover>> {
  return sendPositionRequest<Hover>(
    filePath,
    line,
    column,
    'textDocument/hover',
  );
}
