// Third-party imports
import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import * as logger from '@logger/logUtils';
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - VS Code integration
import * as vscodeIntegration from './VscodeIntegration';

// ============================================================================
// Schema Definitions
// ============================================================================

const LeanDiagnosticsInputSchema = z.strictObject({
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
});

export type LeanDiagnosticsInput = z.infer<typeof LeanDiagnosticsInputSchema>;

const LeanRestartInputSchema = z.strictObject({
  /** Path to the Lean file to restart */
  file: z.string().describe('Path to the .lean file to restart'),
});

export type LeanRestartInput = z.infer<typeof LeanRestartInputSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format an error message for tool output.
 */
function formatError(error: unknown, hint?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return hint ? `Error: ${message}\n\n${hint}` : `Error: ${message}`;
}

/**
 * Resolve a file path to absolute, using workspace folder for relative paths.
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
 * Open a file in VS Code and position cursor at given line.
 * This triggers the Lean 4 extension to process the file.
 * Returns the absolute file path that was opened.
 * Reuses existing editor if file is already open.
 */
async function openFileInEditor(
  filePath: string,
  line?: number,
  column?: number,
): Promise<string | undefined> {
  try {
    // Resolve to absolute path using workspace folder
    const absolutePath = resolveFilePath(filePath);
    const uri = vscode.Uri.file(absolutePath);

    logger.debug('Lean4', `Opening file: ${absolutePath}`);

    // Check if file is already open in an editor
    const existingEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === uri.fsPath,
    );

    let editor: vscode.TextEditor;
    if (existingEditor) {
      // Reuse existing editor
      editor = await vscode.window.showTextDocument(existingEditor.document, {
        viewColumn: existingEditor.viewColumn,
        preserveFocus: false,
      });
    } else {
      // Open new editor
      const document = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(document, {
        preserveFocus: false,
        preview: false,
      });
    }

    if (line !== undefined) {
      const position = new vscode.Position(
        Math.max(0, line - 1),
        column ? Math.max(0, column - 1) : 0,
      );
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }

    logger.debug('Lean4', `File opened successfully: ${absolutePath}`);
    return absolutePath;
  } catch (error) {
    logger.debug('Lean4', `Failed to open file: ${filePath}: ${error}`);
    return undefined;
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Wait for diagnostics to become available using event subscription
 * with polling fallback for robustness.
 *
 * Uses vscode.languages.onDidChangeDiagnostics event (recommended by VS Code)
 * combined with polling to handle edge cases where events might be missed.
 */
async function waitForDiagnostics(
  file: string,
  maxWaitMs: number = 3000,
): Promise<vscodeIntegration.LeanDiagnostic[]> {
  // Resolve to absolute path using workspace folder
  const absolutePath = resolveFilePath(file);
  const uri = vscode.Uri.file(absolutePath);
  const startTime = Date.now();
  const pollInterval = 200;

  // Quick initial check - diagnostics may already be available
  const diagnostics = vscodeIntegration.getDiagnostics(absolutePath);
  if (diagnostics.length > 0) {
    return diagnostics;
  }

  // Set up promise that resolves on diagnostic change event
  const waitForChange = new Promise<vscodeIntegration.LeanDiagnostic[]>(
    (resolve) => {
      const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
        // Check if this event is for our file (case-insensitive path match)
        const hasOurFile = e.uris.some(
          (diagUri) =>
            diagUri.fsPath.toLowerCase() === uri.fsPath.toLowerCase(),
        );

        if (hasOurFile) {
          const updated = vscodeIntegration.getDiagnostics(absolutePath);
          if (updated.length > 0) {
            disposable.dispose();
            resolve(updated);
          }
        }
      });

      // Cleanup subscription on timeout
      setTimeout(() => disposable.dispose(), maxWaitMs);
    },
  );

  // Polling fallback - handles cases where events might be missed
  const pollFallback = new Promise<vscodeIntegration.LeanDiagnostic[]>(
    (resolve) => {
      const pollTimer = setInterval(() => {
        if (Date.now() - startTime >= maxWaitMs) {
          clearInterval(pollTimer);
          resolve(vscodeIntegration.getDiagnostics(absolutePath));
        } else {
          const updated = vscodeIntegration.getDiagnostics(absolutePath);
          if (updated.length > 0) {
            clearInterval(pollTimer);
            resolve(updated);
          }
        }
      }, pollInterval);
    },
  );

  // Race: return whichever resolves first (event or polling)
  return Promise.race([waitForChange, pollFallback]);
}

/**
 * Get diagnostics for a file from VS Code.
 */
export class LeanDiagnosticsTool extends defineTool({
  name: 'lean_diagnostics',
  description: `Get all diagnostic messages (errors, warnings, info) for a Lean 4 file.

Returns diagnostics from the Lean 4 VS Code extension including:
- Compilation errors with location
- Type mismatches
- Unsolved goals
- Warnings and hints

This shows the same diagnostics as VS Code's Problems panel.

Note: If Lean cannot load the file (e.g., bad imports), errors may only appear
in the Lean 4 output panel, not as LSP diagnostics. Check the output panel if
this tool reports no diagnostics but you see errors in VS Code.

Requires: Lean 4 VS Code extension installed and active.`,
  schema: LeanDiagnosticsInputSchema,
}) {
  protected async execute(input: LeanDiagnosticsInput): Promise<ToolResult> {
    const { file } = input;
    const {
      Error: E,
      Warning: W,
      Information: I,
      Hint: H,
    } = vscodeIntegration.DiagnosticSeverity;

    try {
      // Open file first to trigger Lean processing - this is REQUIRED
      const openedPath = await openFileInEditor(file);
      if (!openedPath) {
        return {
          summary: 'Failed to open file',
          output: `Could not open file: ${file}\n\nMake sure the file exists and is accessible.`,
          isError: true,
        };
      }

      // Wait for Lean to process and populate diagnostics (using the resolved path)
      const diagnostics = await waitForDiagnostics(openedPath);

      // Position at first error if any
      const firstError = diagnostics.find((d) => d.severity === E);
      if (firstError) {
        await openFileInEditor(openedPath, firstError.range.start.line + 1);
      }

      if (diagnostics.length === 0) {
        return {
          summary: '✓ No diagnostics',
          output:
            'No errors, warnings, or hints for this file.\n\n' +
            'Note: If you see errors in VS Code, they may be in the Lean 4 output panel ' +
            '(import/dependency errors are shown there instead of as LSP diagnostics).',
        };
      }

      const errors = diagnostics.filter((d) => d.severity === E);
      const warnings = diagnostics.filter((d) => d.severity === W);
      const hints = diagnostics.filter(
        (d) => d.severity === I || d.severity === H,
      );

      const formatSection = (
        title: string,
        items: vscodeIntegration.LeanDiagnostic[],
      ): string =>
        items.length === 0
          ? ''
          : `## ${title} (${items.length})\n\n` +
            items
              .map((d) => `**Line ${d.range.start.line + 1}:** ${d.message}\n`)
              .join('\n');

      const output = [
        formatSection('Errors', errors),
        formatSection('Warnings', warnings),
        formatSection('Info/Hints', hints),
      ]
        .filter(Boolean)
        .join('\n');

      return {
        summary: `${errors.length} error(s), ${warnings.length} warning(s), ${hints.length} hint(s)`,
        output,
        diagnostics: {
          errors: errors.length,
          warnings: warnings.length,
          hints: hints.length,
          details: diagnostics,
        },
      };
    } catch (error) {
      const hint =
        'Make sure the Lean 4 VS Code extension is installed and active.';
      return {
        summary: 'Failed to get diagnostics',
        output: formatError(error, hint),
        isError: true,
      };
    }
  }
}

/**
 * Restart the Lean file server to pick up changes in imports/dependencies.
 */
export class LeanRestartTool extends defineTool({
  name: 'lean_restart',
  description: `Restart the Lean server for a file to pick up changes in imports or dependencies.

Use this when:
- You edited an imported file and want the changes visible in the importing file
- You changed lakefile.lean or lake-manifest.json
- Diagnostics seem stale or incorrect

This triggers the Lean 4 extension's "Restart File" command.`,
  schema: LeanRestartInputSchema,
}) {
  protected async execute(input: LeanRestartInput): Promise<ToolResult> {
    const { file } = input;

    try {
      const success = await vscodeIntegration.restartFileServer(file);

      if (success) {
        return {
          summary: `Restarted Lean server for ${file}`,
          output:
            'File server restarted. Lean will re-process the file and update diagnostics.',
        };
      }

      return {
        summary: 'Failed to restart',
        output: 'Could not restart the Lean server. Is the file open?',
        isError: true,
      };
    } catch (error) {
      return {
        summary: 'Failed to restart',
        output: formatError(error),
        isError: true,
      };
    }
  }
}
