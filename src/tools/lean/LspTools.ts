// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - VS Code integration (primary)
import * as vscodeIntegration from './VscodeIntegration';

// Local imports - Standalone LSP client (fallback)
import { getLspClient } from './LeanLspClient';

// ============================================================================
// Schema Definitions
// ============================================================================

const LeanLspGoalInputSchema = z.strictObject({
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
  /** Line number (1-indexed for user convenience, converted to 0-indexed for LSP) */
  line: z.number().describe('Line number (1-indexed)'),
  /** Column number (1-indexed, optional - defaults to end of line) */
  column: z.number().optional().describe('Column number (1-indexed)'),
  /** Project root directory (optional, for standalone LSP fallback) */
  cwd: z.string().optional().describe('Project root directory'),
});

export type LeanLspGoalInput = z.infer<typeof LeanLspGoalInputSchema>;

const LeanHoverInputSchema = z.strictObject({
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
  /** Line number (1-indexed) */
  line: z.number().describe('Line number (1-indexed)'),
  /** Column number (1-indexed) */
  column: z.number().describe('Column number (1-indexed)'),
  /** Project root directory (optional) */
  cwd: z.string().optional().describe('Project root directory'),
});

export type LeanHoverInput = z.infer<typeof LeanHoverInputSchema>;

const LeanCompletionsInputSchema = z.strictObject({
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
  /** Line number (1-indexed) */
  line: z.number().describe('Line number (1-indexed)'),
  /** Column number (1-indexed) */
  column: z.number().describe('Column number (1-indexed)'),
  /** Project root directory (optional) */
  cwd: z.string().optional().describe('Project root directory'),
  /** Maximum number of completions to return */
  limit: z.number().prefault(20).describe('Max completions to return'),
});

export type LeanCompletionsInput = z.infer<typeof LeanCompletionsInputSchema>;

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

/**
 * Check if we're running in VS Code context.
 */
function isVscodeContext(): boolean {
  try {
    // vscode module is only available in VS Code extension context
    require('vscode');
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get proof goal state at a position.
 * Uses VS Code's Lean 4 extension when available, falls back to standalone LSP.
 */
export class LeanLspGoalTool extends defineTool({
  name: 'lean_lsp_goal',
  description: `Get the proof goal state at a specific position in a Lean 4 file.

This provides real-time goal information by querying the Lean language server.
When the Lean 4 VS Code extension is installed, it uses the extension's LSP connection.

Usage:
- Specify file, line (1-indexed), and optionally column
- Returns the current proof context and goals at that position

Example output:
  Context:
    n : Nat
    h : n > 0
  Goals:
    1. ⊢ n + 1 > 1`,
  schema: LeanLspGoalInputSchema,
}) {
  protected async execute(input: LeanLspGoalInput): Promise<ToolResult> {
    const { file, line, column, cwd } = input;
    const { line: lspLine, character } = toZeroIndexed(line, column);

    // Try VS Code integration first
    if (isVscodeContext()) {
      try {
        const goalState = await vscodeIntegration.getGoalState(
          file,
          lspLine,
          character,
        );

        if (goalState) {
          return this.formatGoalResult(goalState, line);
        }
      } catch {
        // Fall through to standalone client
      }
    }

    // Fallback to standalone LSP client
    const client = getLspClient(cwd);
    try {
      const goalState = await client.getGoalState(file, lspLine, character);
      if (goalState) {
        return this.formatGoalResult(goalState, line);
      }
    } catch (error) {
      return {
        summary: 'Failed to get goal state',
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    return {
      summary: `No goal state at line ${line}`,
      output:
        'No proof goal found at this position. This may not be inside a tactic proof.',
    };
  }

  private formatGoalResult(
    goalState: { goals: string[]; rendered?: string },
    line: number,
  ): ToolResult {
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
  }
}

/**
 * Get hover information (documentation, type) at a position.
 * Uses VS Code's built-in hover provider which works with the Lean 4 extension.
 */
export class LeanHoverTool extends defineTool({
  name: 'lean_hover',
  description: `Get hover information for a symbol at a specific position in a Lean 4 file.

Returns documentation, type signatures, and other information.
Uses the Lean 4 VS Code extension's language server when available.

Useful for:
- Understanding the type of an expression
- Reading documentation for a theorem or definition
- Exploring available lemmas and their signatures`,
  schema: LeanHoverInputSchema,
}) {
  protected async execute(input: LeanHoverInput): Promise<ToolResult> {
    const { file, line, column, cwd } = input;
    const { line: lspLine, character } = toZeroIndexed(line, column);

    // Try VS Code integration first
    if (isVscodeContext()) {
      try {
        const hover = await vscodeIntegration.getHover(
          file,
          lspLine,
          character,
        );

        if (hover) {
          return {
            summary: `Hover info at line ${line}:${column}`,
            output: hover.contents,
            diagnostics: { hover },
          };
        }
      } catch {
        // Fall through to standalone client
      }
    }

    // Fallback to standalone LSP client
    const client = getLspClient(cwd);
    try {
      const hover = await client.getHover(file, lspLine, character);

      if (hover) {
        const contents =
          typeof hover.contents === 'string'
            ? hover.contents
            : hover.contents.value;
        return {
          summary: `Hover info at line ${line}:${column}`,
          output: contents,
          diagnostics: { hover },
        };
      }
    } catch (error) {
      return {
        summary: 'Failed to get hover info',
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    return {
      summary: `No hover info at line ${line}:${column}`,
      output: 'No information available at this position.',
    };
  }
}

/**
 * Get completions at a position.
 * Uses VS Code's built-in completion provider.
 */
export class LeanCompletionsTool extends defineTool({
  name: 'lean_completions',
  description: `Get auto-completion suggestions at a specific position in a Lean 4 file.

Returns a list of possible completions including:
- Available tactics
- Theorem and lemma names
- Variable names in scope
- Type constructors

Useful for discovering available tactics or finding the right lemma name.`,
  schema: LeanCompletionsInputSchema,
}) {
  protected async execute(input: LeanCompletionsInput): Promise<ToolResult> {
    const { file, line, column, cwd, limit } = input;
    const { line: lspLine, character } = toZeroIndexed(line, column);

    // Try VS Code integration first
    if (isVscodeContext()) {
      try {
        const completions = await vscodeIntegration.getCompletions(
          file,
          lspLine,
          character,
          limit,
        );

        if (completions.length > 0) {
          return this.formatCompletions(completions, line, column, limit);
        }
      } catch {
        // Fall through to standalone client
      }
    }

    // Fallback to standalone LSP client
    const client = getLspClient(cwd);
    try {
      const completions = await client.getCompletions(file, lspLine, character);
      const limitedCompletions = completions.slice(0, limit);

      if (limitedCompletions.length > 0) {
        const formatted = limitedCompletions.map((item) => {
          const c = item as {
            label: string;
            detail?: string;
            documentation?: string | { value: string };
          };
          return {
            label: c.label,
            detail: c.detail,
            documentation:
              typeof c.documentation === 'string'
                ? c.documentation
                : c.documentation?.value,
          };
        });

        return this.formatCompletions(
          formatted,
          line,
          column,
          limit,
          completions.length,
        );
      }
    } catch (error) {
      return {
        summary: 'Failed to get completions',
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    return {
      summary: 'No completions available',
      output: 'No completion suggestions at this position.',
    };
  }

  private formatCompletions(
    completions: { label: string; detail?: string; documentation?: string }[],
    line: number,
    column: number,
    limit: number,
    totalCount?: number,
  ): ToolResult {
    let output = `## Completions at Line ${line}:${column}\n\n`;

    for (const item of completions) {
      output += `- **${item.label}**`;
      if (item.detail) {
        output += `: ${item.detail}`;
      }
      output += '\n';

      if (item.documentation) {
        output += `  ${item.documentation.split('\n')[0]}\n`;
      }
    }

    const total = totalCount ?? completions.length;
    if (total > limit) {
      output += `\n*Showing ${limit} of ${total} completions*`;
    }

    return {
      summary: `Found ${completions.length} completion(s)`,
      output,
      diagnostics: { completions, total },
    };
  }
}

/**
 * Get term goal at a position (for term-mode proofs).
 */
export class LeanTermGoalTool extends defineTool({
  name: 'lean_term_goal',
  description: `Get the expected type (term goal) at a specific position in a Lean 4 file.

Unlike lean_lsp_goal which shows tactic proof goals, this shows what type of term
is expected at a given position. Useful in term-mode proofs or when constructing
expressions.

Example: If you're filling in a hole (_ or ?x), this shows what type is expected.`,
  schema: LeanLspGoalInputSchema,
}) {
  protected async execute(input: LeanLspGoalInput): Promise<ToolResult> {
    const { file, line, column, cwd } = input;
    const { line: lspLine, character } = toZeroIndexed(line, column);

    // Try VS Code integration first
    if (isVscodeContext()) {
      try {
        const termGoal = await vscodeIntegration.getTermGoal(
          file,
          lspLine,
          character,
        );

        if (termGoal) {
          let output = `## Expected Type at Line ${line}\n\n`;
          output += `**Goal:** ${termGoal.goal}\n`;

          if (termGoal.range) {
            output += `\n*Range: lines ${termGoal.range.start.line + 1}-${termGoal.range.end.line + 1}*`;
          }

          return {
            summary: `Found term goal at line ${line}`,
            output,
            diagnostics: { termGoal },
          };
        }
      } catch {
        // Fall through to standalone client
      }
    }

    // Fallback to standalone LSP client
    const client = getLspClient(cwd);
    try {
      const termGoal = await client.getTermGoal(file, lspLine, character);

      if (termGoal) {
        let output = `## Expected Type at Line ${line}\n\n`;
        output += `**Goal:** ${termGoal.goal}\n`;

        if (termGoal.range) {
          output += `\n*Range: lines ${termGoal.range.start.line + 1}-${termGoal.range.end.line + 1}*`;
        }

        return {
          summary: `Found term goal at line ${line}`,
          output,
          diagnostics: { termGoal },
        };
      }
    } catch (error) {
      return {
        summary: 'Failed to get term goal',
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    return {
      summary: `No term goal at line ${line}`,
      output: 'No expected type found at this position.',
    };
  }
}

/**
 * Get diagnostics for a file.
 * Uses VS Code's diagnostics API which aggregates from all language servers.
 */
export class LeanDiagnosticsTool extends defineTool({
  name: 'lean_diagnostics',
  description: `Get all diagnostic messages (errors, warnings, info) for a Lean 4 file.

Returns diagnostics from the Lean language server including:
- Compilation errors with location
- Type mismatches
- Unsolved goals
- Warnings and hints

This uses the same diagnostics shown in VS Code's Problems panel.`,
  schema: LeanDiagnosticsInputSchema,
}) {
  protected async execute(input: LeanDiagnosticsInput): Promise<ToolResult> {
    const { file } = input;

    if (!isVscodeContext()) {
      return {
        summary: 'Diagnostics require VS Code',
        output:
          'The lean_diagnostics tool requires VS Code context.\n' +
          'Use lean_check instead for CLI-based compilation errors.',
        isError: true,
      };
    }

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
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}
