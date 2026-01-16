// Third-party imports
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

const LeanLspGoalInputSchema = z.strictObject({
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
  /** Line number (1-indexed) */
  line: z.number().describe('Line number (1-indexed)'),
  /** Column number (1-indexed, optional) */
  column: z.number().nullish().describe('Column number (1-indexed)'),
});

export type LeanLspGoalInput = z.infer<typeof LeanLspGoalInputSchema>;

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
 * Convert 1-indexed user coordinates to 0-indexed LSP coordinates.
 */
function toZeroIndexed(
  line: number,
  column?: number,
): { line: number; character: number } {
  return {
    line: Math.max(0, line - 1),
    character: column ? Math.max(0, column - 1) : 0,
  };
}

/**
 * Open a file in VS Code and position cursor at given line.
 * This allows the user to see the Lean 4 InfoView showing goal state and diagnostics.
 */
async function openFileAtPosition(
  filePath: string,
  line?: number,
  column?: number,
): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {
      preserveFocus: false, // Focus the editor so InfoView updates
      preview: false, // Don't use preview mode
    });

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
  } catch (error) {
    // Opening file is a nice-to-have for user visibility, not critical for tool operation
    logger.debug('Lean4', `Failed to open file in editor: ${error}`);
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get proof goal state at a position using the Lean 4 VS Code extension.
 */
export class LeanLspGoalTool extends defineTool({
  name: 'lean_lsp_goal',
  description: `Get the proof goal state at a specific position in a Lean 4 file.

Queries the Lean 4 VS Code extension's language server for real-time goal information.

Usage:
- Specify file, line (1-indexed), and optionally column
- Returns the current proof context and goals at that position

Requires: Lean 4 VS Code extension installed and active.

Example output:
  Context:
    n : Nat
    h : n > 0
  Goals:
    1. ⊢ n + 1 > 1`,
  schema: LeanLspGoalInputSchema,
}) {
  protected async execute(input: LeanLspGoalInput): Promise<ToolResult> {
    const { file, line, column } = input;
    // Convert nullish to undefined for functions that expect undefined
    const col = column ?? undefined;
    const { line: lspLine, character } = toZeroIndexed(line, col);

    // Open file in VS Code so user can see InfoView with goal state
    await openFileAtPosition(file, line, col);

    try {
      const goalState = await vscodeIntegration.getGoalState(
        file,
        lspLine,
        character,
      );

      if (!goalState) {
        return {
          summary: `No goal state at line ${line}`,
          output:
            'No proof goal found at this position. This may not be inside a tactic proof.',
        };
      }

      let output = `## Goal State at Line ${line}\n\n`;

      if (goalState.rendered) {
        output += goalState.rendered;
      } else if (goalState.goals.length > 0) {
        output += '**Goals:**\n';
        for (let i = 0; i < goalState.goals.length; i++) {
          output += `${i + 1}. ${goalState.goals[i]}\n`;
        }
      }

      return {
        summary: `Found ${goalState.goals.length} goal(s) at line ${line}`,
        output,
        diagnostics: { goalState },
      };
    } catch (error) {
      return {
        summary: 'Failed to get goal state',
        output: `Error: ${error instanceof Error ? error.message : String(error)}\n\nMake sure the Lean 4 VS Code extension is installed and active.`,
        isError: true,
      };
    }
  }
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

Requires: Lean 4 VS Code extension installed and active.`,
  schema: LeanDiagnosticsInputSchema,
}) {
  protected async execute(input: LeanDiagnosticsInput): Promise<ToolResult> {
    const { file } = input;

    try {
      const diagnostics = vscodeIntegration.getDiagnostics(file);

      // Open file in VS Code - position at first error if any
      const firstError = diagnostics.find(
        (d) => d.severity === vscodeIntegration.DiagnosticSeverity.Error,
      );
      const openLine = firstError ? firstError.range.start.line + 1 : undefined;
      await openFileAtPosition(file, openLine);

      if (diagnostics.length === 0) {
        return {
          summary: '✓ No diagnostics',
          output: 'No errors, warnings, or hints for this file.',
        };
      }

      const errors = diagnostics.filter(
        (d) => d.severity === vscodeIntegration.DiagnosticSeverity.Error,
      );
      const warnings = diagnostics.filter(
        (d) => d.severity === vscodeIntegration.DiagnosticSeverity.Warning,
      );
      const hints = diagnostics.filter(
        (d) =>
          d.severity === vscodeIntegration.DiagnosticSeverity.Information ||
          d.severity === vscodeIntegration.DiagnosticSeverity.Hint,
      );

      let output = '';

      if (errors.length > 0) {
        output += `## Errors (${errors.length})\n\n`;
        for (const e of errors) {
          output += `**Line ${e.range.start.line + 1}:** ${e.message}\n\n`;
        }
      }

      if (warnings.length > 0) {
        output += `## Warnings (${warnings.length})\n\n`;
        for (const w of warnings) {
          output += `**Line ${w.range.start.line + 1}:** ${w.message}\n\n`;
        }
      }

      if (hints.length > 0) {
        output += `## Info/Hints (${hints.length})\n\n`;
        for (const h of hints) {
          output += `**Line ${h.range.start.line + 1}:** ${h.message}\n\n`;
        }
      }

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
      return {
        summary: 'Failed to get diagnostics',
        output: `Error: ${error instanceof Error ? error.message : String(error)}\n\nMake sure the Lean 4 VS Code extension is installed and active.`,
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
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}
