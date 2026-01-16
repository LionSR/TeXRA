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
// Utilities
// ============================================================================

/**
 * Resolve file path to absolute, using workspace folder for relative paths.
 */
function resolveFilePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Use workspace folder for relative paths
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    return path.join(workspaceFolders[0].uri.fsPath, filePath);
  }

  // Fallback to cwd (may not work in extension context)
  return path.resolve(filePath);
}

/**
 * Resolve file path and create VS Code URI.
 */
function resolveFileUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(resolveFilePath(filePath));
}

/**
 * Execute a VS Code command and return success status.
 */
async function executeVscodeCommand(command: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(command);
    return true;
  } catch (error) {
    logger.debug('Lean4', `Failed to execute ${command}: ${error}`);
    return false;
  }
}

/**
 * Type guard to check if value is a non-null object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Safely extract string content from VS Code hover/completion content.
 */
function extractContentString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content instanceof vscode.MarkdownString) return content.value;
  if (
    isObject(content) &&
    'value' in content &&
    typeof content.value === 'string'
  ) {
    return content.value;
  }
  return '';
}

/** Position with line and character. */
interface Position {
  line: number;
  character: number;
}

/** Range with start and end positions. */
interface Range {
  start: Position;
  end: Position;
}

/**
 * Parse and validate a range object from LSP response.
 */
function parseRange(obj: Record<string, unknown>): Range | undefined {
  if (!('range' in obj) || !isObject(obj.range)) return undefined;

  const r = obj.range;
  if (!isObject(r.start) || !isObject(r.end)) return undefined;

  const start = r.start;
  const end = r.end;
  if (
    typeof start.line !== 'number' ||
    typeof start.character !== 'number' ||
    typeof end.line !== 'number' ||
    typeof end.character !== 'number'
  ) {
    return undefined;
  }

  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  };
}

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
  range?: Range;
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
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
}

/** Hover information */
export interface LeanHoverInfo {
  contents: string;
  range?: Range;
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
    logger.debug('Lean4', 'Lean 4 extension not found');
    return undefined;
  }

  logger.debug('Lean4', `Extension found, isActive: ${extension.isActive}`);

  if (!extension.isActive) {
    try {
      await extension.activate();
      logger.debug('Lean4', 'Extension activated');
    } catch (error) {
      logger.debug('Lean4', `Failed to activate extension: ${error}`);
      return undefined;
    }
  }

  const exports = extension.exports as Lean4ExtensionExports;
  logger.debug(
    'Lean4',
    `Extension exports: ${exports ? Object.keys(exports).join(', ') : 'none'}`,
  );

  return exports;
}

/**
 * Get the Lean client for a file path.
 */
async function getLeanClient(
  filePath: string,
): Promise<LeanClient | undefined> {
  const exports = await getLean4Extension();
  if (!exports?.clientProvider) {
    logger.debug('Lean4', 'No clientProvider in extension exports');
    return undefined;
  }

  // Try to find client for this file
  logger.debug('Lean4', `Looking for client for: ${filePath}`);
  const client = exports.clientProvider.findClient(filePath);
  if (client) {
    logger.debug('Lean4', 'Found client via findClient');
    return client;
  }
  logger.debug(
    'Lean4',
    'findClient returned undefined, trying getActiveClient',
  );

  // Fall back to active client
  const activeClient = exports.clientProvider.getActiveClient();
  if (activeClient) {
    logger.debug('Lean4', 'Found client via getActiveClient');
  } else {
    logger.debug('Lean4', 'getActiveClient also returned undefined');
  }
  return activeClient;
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
  try {
    const uri = resolveFileUri(filePath);
    let diagnostics = vscode.languages.getDiagnostics(uri);

    // If no diagnostics found, try to find by matching path in all diagnostics
    if (diagnostics.length === 0) {
      const allDiagnostics = vscode.languages.getDiagnostics();
      const resolvedPath = uri.fsPath.toLowerCase();

      for (const [diagUri, diags] of allDiagnostics) {
        if (diagUri.fsPath.toLowerCase() === resolvedPath && diags.length > 0) {
          diagnostics = diags;
          logger.debug(
            'Lean4',
            `Found diagnostics via path match: ${diagUri.toString()}`,
          );
          break;
        }
      }

      // Log available URIs for debugging
      if (diagnostics.length === 0) {
        const urisWithDiags = allDiagnostics
          .filter(([, d]) => d.length > 0)
          .map(([u]) => u.toString());
        logger.debug(
          'Lean4',
          `No diagnostics for ${uri.toString()}. ` +
            `Available: ${urisWithDiags.slice(0, 5).join(', ')}`,
        );
      }
    }

    return diagnostics.map((d) => ({
      range: {
        start: { line: d.range.start.line, character: d.range.start.character },
        end: { line: d.range.end.line, character: d.range.end.character },
      },
      message: d.message,
      severity: d.severity as DiagnosticSeverity,
      source: d.source,
    }));
  } catch (error) {
    logger.debug('Lean4', `Failed to get diagnostics: ${error}`);
    return [];
  }
}

/**
 * Get hover information at a position using VS Code's hover provider.
 */
export async function getHover(
  filePath: string,
  line: number,
  character: number,
): Promise<LeanHoverInfo | undefined> {
  const uri = resolveFileUri(filePath);
  const position = new vscode.Position(line, character);

  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    uri,
    position,
  );

  if (!hovers || hovers.length === 0) {
    return undefined;
  }

  // Combine all hover contents with safe extraction
  const contents = hovers
    .flatMap((h) => h.contents.map(extractContentString))
    .filter(Boolean)
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
  const uri = resolveFileUri(filePath);
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
    // Safely extract label - handle both string and CompletionItemLabel object
    label:
      typeof item.label === 'string'
        ? item.label
        : (item.label?.label ?? 'unknown'),
    detail: item.detail,
    documentation: extractContentString(item.documentation) || undefined,
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
    logger.debug('Lean4', `No Lean client found for: ${filePath}`);
    return undefined;
  }

  const uri = resolveFileUri(filePath);
  logger.debug(
    'Lean4',
    `getGoalState: ${uri.toString()} at ${line}:${character}`,
  );

  try {
    const result = await client.sendRequest(LSP_METHOD.PLAIN_GOAL, {
      textDocument: { uri: uri.toString() },
      position: { line, character },
    });

    logger.debug('Lean4', `plainGoal result: ${JSON.stringify(result)}`);

    if (!result || !isObject(result)) {
      logger.debug('Lean4', 'plainGoal: no result or not an object');
      return undefined;
    }

    // Handle response with goals array - validate each item is a string
    if ('goals' in result && Array.isArray(result.goals)) {
      logger.debug(
        'Lean4',
        `Found goals array with ${result.goals.length} items`,
      );
      const validGoals = result.goals.filter(
        (g): g is string => typeof g === 'string',
      );
      if (validGoals.length > 0) {
        return {
          goals: validGoals,
          rendered:
            'rendered' in result && typeof result.rendered === 'string'
              ? result.rendered
              : undefined,
        };
      }
      // Goals array exists but is empty - no goals at this position
      logger.debug('Lean4', 'Goals array is empty');
    }

    // Handle response with only rendered string
    if ('rendered' in result && typeof result.rendered === 'string') {
      logger.debug(
        'Lean4',
        `Found rendered string: ${result.rendered.substring(0, 100)}...`,
      );
      return {
        goals: [result.rendered],
        rendered: result.rendered,
      };
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

  const uri = resolveFileUri(filePath);

  try {
    const result = await client.sendRequest(LSP_METHOD.PLAIN_TERM_GOAL, {
      textDocument: { uri: uri.toString() },
      position: { line, character },
    });

    if (!result || !isObject(result)) {
      return undefined;
    }

    if ('goal' in result && typeof result.goal === 'string') {
      return {
        goal: result.goal,
        range: parseRange(result),
      };
    }

    return undefined;
  } catch (error) {
    logger.debug('Lean4', `Failed to get term goal: ${error}`);
    return undefined;
  }
}

/** Restart the Lean server for the current file. */
export function restartFile(): Promise<boolean> {
  return executeVscodeCommand('lean4.restartFile');
}

/** Restart the entire Lean server. */
export function restartServer(): Promise<boolean> {
  return executeVscodeCommand('lean4.restartServer');
}

/** Build the Lean project. */
export function buildProject(): Promise<boolean> {
  return executeVscodeCommand('lean4.project.build');
}

/** Fetch Mathlib cache. */
export function fetchMathlibCache(): Promise<boolean> {
  return executeVscodeCommand('lean4.project.fetchCache');
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
    const uri = resolveFileUri(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preserveFocus: true });
    await vscode.commands.executeCommand('lean4.restartFile');
    return true;
  } catch (error) {
    logger.debug('Lean4', `Failed to restart file server: ${error}`);
    return false;
  }
}
