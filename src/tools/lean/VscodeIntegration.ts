/**
 * VS Code integration with the Lean 4 extension.
 *
 * Provides access to Lean 4 diagnostics via VS Code's built-in language APIs.
 */

import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Utilities
// ============================================================================

/**
 * Resolve file path and create VS Code URI.
 */
function resolveFileUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(WorkspaceFS.toAbsolute(filePath));
}

// ============================================================================
// Public API
// ============================================================================

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
