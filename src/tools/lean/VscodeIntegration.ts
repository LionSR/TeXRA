/**
 * VS Code integration with the Lean 4 extension.
 *
 * This module provides access to Lean 4 language features by:
 * 1. Using VS Code's built-in language APIs (hover, completions, diagnostics)
 * 2. Accessing the Lean 4 extension's client for goal state
 *
 * This approach reuses the existing Lean 4 extension's LSP connection
 * instead of spawning our own `lake serve` instance.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';

// ============================================================================
// Constants
// ============================================================================

/** Lean 4 VS Code extension identifier */
const LEAN4_EXTENSION_ID = 'leanprover.lean4';

/** Lean LSP method names */
const LSP_METHOD = {
  PLAIN_GOAL: '$/lean/plainGoal',
  PLAIN_TERM_GOAL: '$/lean/plainTermGoal',
} as const;

// ============================================================================
// Types
// ============================================================================

/** Goal state from Lean's $/lean/plainGoal request */
export interface LeanGoalState {
  goals: string[];
  rendered?: string;
}

/** Term goal from Lean's $/lean/plainTermGoal request */
export interface LeanTermGoal {
  goal: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** Diagnostic severity levels */
export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

/** Structured diagnostic info */
export interface LeanDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
}

/** Hover information */
export interface LeanHoverInfo {
  contents: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** Completion item */
export interface LeanCompletionItem {
  label: string;
  detail?: string;
  documentation?: string;
  kind?: string;
}

// ============================================================================
// Lean 4 Extension Access
// ============================================================================

interface Lean4ExtensionExports {
  clientProvider?: {
    getActiveClient(): LeanClient | undefined;
    getClientForFolder(folder: vscode.Uri): LeanClient | undefined;
    findClient(path: string): LeanClient | undefined;
  };
}

interface LeanClient {
  sendRequest(method: string, params: unknown): Promise<unknown>;
  isRunning(): boolean;
}

/**
 * Get the Lean 4 extension's exports.
 * Returns undefined if the extension is not installed or not activated.
 */
async function getLean4Extension(): Promise<Lean4ExtensionExports | undefined> {
  const extension = vscode.extensions.getExtension(LEAN4_EXTENSION_ID);
  if (!extension) {
    return undefined;
  }

  if (!extension.isActive) {
    try {
      await extension.activate();
    } catch (error) {
      logger.debug('Lean4', `Failed to activate extension: ${error}`);
      return undefined;
    }
  }

  return extension.exports as Lean4ExtensionExports;
}

/**
 * Get the Lean client for a file path.
 */
async function getLeanClient(
  filePath: string,
): Promise<LeanClient | undefined> {
  const exports = await getLean4Extension();
  if (!exports?.clientProvider) {
    return undefined;
  }

  // Try to find client for this file
  const client = exports.clientProvider.findClient(filePath);
  if (client) {
    return client;
  }

  // Fall back to active client
  return exports.clientProvider.getActiveClient();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if the Lean 4 extension is available.
 */
export async function isLean4ExtensionAvailable(): Promise<boolean> {
  const extension = vscode.extensions.getExtension(LEAN4_EXTENSION_ID);
  return extension !== undefined;
}

/**
 * Get diagnostics for a Lean file using VS Code's diagnostics API.
 * This returns diagnostics from the Lean 4 extension's LSP.
 */
export function getDiagnostics(filePath: string): LeanDiagnostic[] {
  const uri = vscode.Uri.file(
    path.isAbsolute(filePath) ? filePath : path.resolve(filePath),
  );
  const diagnostics = vscode.languages.getDiagnostics(uri);

  return diagnostics.map((d) => ({
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
    message: d.message,
    severity: d.severity as DiagnosticSeverity,
    source: d.source,
  }));
}

/**
 * Get hover information at a position using VS Code's hover provider.
 */
export async function getHover(
  filePath: string,
  line: number,
  character: number,
): Promise<LeanHoverInfo | undefined> {
  const uri = vscode.Uri.file(
    path.isAbsolute(filePath) ? filePath : path.resolve(filePath),
  );
  const position = new vscode.Position(line, character);

  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    uri,
    position,
  );

  if (!hovers || hovers.length === 0) {
    return undefined;
  }

  // Combine all hover contents
  const contents = hovers
    .flatMap((h) =>
      h.contents.map((c) => {
        if (typeof c === 'string') {
          return c;
        }
        if (c instanceof vscode.MarkdownString) {
          return c.value;
        }
        return (c as { value: string }).value;
      }),
    )
    .join('\n\n');

  const firstHover = hovers[0];
  const range = firstHover.range;

  return {
    contents,
    range: range
      ? {
          start: { line: range.start.line, character: range.start.character },
          end: { line: range.end.line, character: range.end.character },
        }
      : undefined,
  };
}

/**
 * Get completions at a position using VS Code's completion provider.
 */
export async function getCompletions(
  filePath: string,
  line: number,
  character: number,
  limit: number = 50,
): Promise<LeanCompletionItem[]> {
  const uri = vscode.Uri.file(
    path.isAbsolute(filePath) ? filePath : path.resolve(filePath),
  );
  const position = new vscode.Position(line, character);

  const completionList = await vscode.commands.executeCommand<
    vscode.CompletionList | vscode.CompletionItem[]
  >('vscode.executeCompletionItemProvider', uri, position);

  if (!completionList) {
    return [];
  }

  const items = Array.isArray(completionList)
    ? completionList
    : completionList.items;

  return items.slice(0, limit).map((item) => ({
    label: typeof item.label === 'string' ? item.label : item.label.label,
    detail: item.detail,
    documentation:
      typeof item.documentation === 'string'
        ? item.documentation
        : item.documentation instanceof vscode.MarkdownString
          ? item.documentation.value
          : undefined,
    kind:
      item.kind !== undefined
        ? vscode.CompletionItemKind[item.kind]
        : undefined,
  }));
}

/**
 * Get proof goal state at a position using the Lean 4 extension's client.
 * This sends a $/lean/plainGoal request to the Lean server.
 */
export async function getGoalState(
  filePath: string,
  line: number,
  character: number,
): Promise<LeanGoalState | undefined> {
  const client = await getLeanClient(filePath);
  if (!client) {
    return undefined;
  }

  const uri = vscode.Uri.file(
    path.isAbsolute(filePath) ? filePath : path.resolve(filePath),
  );

  try {
    const result = await client.sendRequest(LSP_METHOD.PLAIN_GOAL, {
      textDocument: { uri: uri.toString() },
      position: { line, character },
    });

    if (!result) {
      return undefined;
    }

    // Handle different response formats
    if (typeof result === 'object' && result !== null) {
      const r = result as Record<string, unknown>;
      if ('goals' in r && Array.isArray(r.goals)) {
        return {
          goals: r.goals as string[],
          rendered: r.rendered as string | undefined,
        };
      }
      if ('rendered' in r && typeof r.rendered === 'string') {
        return {
          goals: [r.rendered],
          rendered: r.rendered,
        };
      }
    }

    return undefined;
  } catch (error) {
    logger.debug('Lean4', `Failed to get goal state: ${error}`);
    return undefined;
  }
}

/**
 * Get term goal (expected type) at a position.
 * This sends a $/lean/plainTermGoal request to the Lean server.
 */
export async function getTermGoal(
  filePath: string,
  line: number,
  character: number,
): Promise<LeanTermGoal | undefined> {
  const client = await getLeanClient(filePath);
  if (!client) {
    return undefined;
  }

  const uri = vscode.Uri.file(
    path.isAbsolute(filePath) ? filePath : path.resolve(filePath),
  );

  try {
    const result = await client.sendRequest(LSP_METHOD.PLAIN_TERM_GOAL, {
      textDocument: { uri: uri.toString() },
      position: { line, character },
    });

    if (!result || typeof result !== 'object') {
      return undefined;
    }

    const r = result as Record<string, unknown>;
    if ('goal' in r && typeof r.goal === 'string') {
      return {
        goal: r.goal,
        range: r.range as LeanTermGoal['range'],
      };
    }

    return undefined;
  } catch (error) {
    logger.debug('Lean4', `Failed to get term goal: ${error}`);
    return undefined;
  }
}

/**
 * Restart the Lean server for the current file.
 */
export async function restartFile(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('lean4.restartFile');
    return true;
  } catch {
    return false;
  }
}

/**
 * Restart the entire Lean server.
 */
export async function restartServer(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('lean4.restartServer');
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the Lean project.
 */
export async function buildProject(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('lean4.project.build');
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch Mathlib cache.
 */
export async function fetchMathlibCache(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('lean4.project.fetchCache');
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the InfoView panel is visible.
 * The InfoView shows goal state and diagnostics interactively.
 *
 * Note: The Lean 4 extension does not expose a direct "show InfoView" command.
 * The 'lean4.displayGoal' command requires an active editor with Lean file.
 * We use toggleUpdating twice as a workaround - this ensures the InfoView
 * webview is initialized and active without changing its update state.
 * A more reliable approach would require the Lean 4 extension to expose
 * a dedicated API for programmatic InfoView control.
 */
export async function showInfoView(): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('lean4.infoView.toggleUpdating');
    await vscode.commands.executeCommand('lean4.infoView.toggleUpdating');
    return true;
  } catch (error) {
    logger.debug('Lean4', `Failed to show InfoView: ${error}`);
    return false;
  }
}

/**
 * Restart the Lean file server to pick up changes in dependencies.
 * Call this after editing imported files or changing lakefile.
 */
export async function restartFileServer(filePath: string): Promise<boolean> {
  try {
    // Resolve relative paths like other functions in this module
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(filePath);
    const uri = vscode.Uri.file(resolvedPath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preserveFocus: true });

    // Then restart
    await vscode.commands.executeCommand('lean4.restartFile');
    return true;
  } catch (error) {
    logger.debug('Lean4', `Failed to restart file server: ${error}`);
    return false;
  }
}
