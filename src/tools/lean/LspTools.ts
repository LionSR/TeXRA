// Third-party imports
import { z } from 'zod';

// Local imports - tools
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
  column: z.number().optional().describe('Column number (1-indexed)'),
});

export type LeanLspGoalInput = z.infer<typeof LeanLspGoalInputSchema>;

const LeanDiagnosticsInputSchema = z.strictObject({
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
});

export type LeanDiagnosticsInput = z.infer<typeof LeanDiagnosticsInputSchema>;

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
    const { line: lspLine, character } = toZeroIndexed(line, column);

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
