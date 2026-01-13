// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - LSP client
import { getLspClient, DiagnosticSeverity } from './LeanLspClient';

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
  /** Project root directory (optional) */
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
 * Format hover contents for display.
 */
function formatHoverContents(
  contents: string | { kind: string; value: string },
): string {
  if (typeof contents === 'string') {
    return contents;
  }
  return contents.value;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get proof goal state at a position using LSP.
 * This provides real-time goal information without needing to compile the file.
 */
export class LeanLspGoalTool extends defineTool({
  name: 'lean_lsp_goal',
  description: `Get the proof goal state at a specific position in a Lean 4 file using the language server.

This provides real-time goal information by querying the Lean language server directly,
without needing to compile the entire file first.

Usage:
- Specify file, line (1-indexed), and optionally column
- Returns the current proof context and goals at that position

The first call may take longer as it starts the language server.
Subsequent calls reuse the connection for faster responses.

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

    const client = getLspClient(cwd);

    try {
      const goalState = await client.getGoalState(file, lspLine, character);

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
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}

/**
 * Get hover information (documentation, type) at a position.
 */
export class LeanHoverTool extends defineTool({
  name: 'lean_hover',
  description: `Get hover information for a symbol at a specific position in a Lean 4 file.

Returns documentation, type signatures, and other information that would appear
when hovering over a symbol in the IDE.

Useful for:
- Understanding the type of an expression
- Reading documentation for a theorem or definition
- Exploring available lemmas and their signatures`,
  schema: LeanHoverInputSchema,
}) {
  protected async execute(input: LeanHoverInput): Promise<ToolResult> {
    const { file, line, column, cwd } = input;
    const { line: lspLine, character } = toZeroIndexed(line, column);

    const client = getLspClient(cwd);

    try {
      const hover = await client.getHover(file, lspLine, character);

      if (!hover) {
        return {
          summary: `No hover info at line ${line}:${column}`,
          output: 'No information available at this position.',
        };
      }

      const contents = formatHoverContents(hover.contents);

      return {
        summary: `Hover info at line ${line}:${column}`,
        output: contents,
        diagnostics: { hover },
      };
    } catch (error) {
      return {
        summary: 'Failed to get hover info',
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}

/**
 * Get completions at a position.
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

    const client = getLspClient(cwd);

    try {
      const completions = await client.getCompletions(file, lspLine, character);
      const limitedCompletions = completions.slice(0, limit);

      if (limitedCompletions.length === 0) {
        return {
          summary: 'No completions available',
          output: 'No completion suggestions at this position.',
        };
      }

      let output = `## Completions at Line ${line}:${column}\n\n`;

      for (const item of limitedCompletions) {
        const completion = item as {
          label: string;
          detail?: string;
          documentation?: string | { value: string };
        };

        output += `- **${completion.label}**`;
        if (completion.detail) {
          output += `: ${completion.detail}`;
        }
        output += '\n';

        if (completion.documentation) {
          const doc =
            typeof completion.documentation === 'string'
              ? completion.documentation
              : completion.documentation.value;
          if (doc) {
            output += `  ${doc.split('\n')[0]}\n`;
          }
        }
      }

      const totalCount = completions.length;
      if (totalCount > limit) {
        output += `\n*Showing ${limit} of ${totalCount} completions*`;
      }

      return {
        summary: `Found ${limitedCompletions.length} completion(s)`,
        output,
        diagnostics: { completions: limitedCompletions, total: totalCount },
      };
    } catch (error) {
      return {
        summary: 'Failed to get completions',
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
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

    const client = getLspClient(cwd);

    try {
      const termGoal = await client.getTermGoal(file, lspLine, character);

      if (!termGoal) {
        return {
          summary: `No term goal at line ${line}`,
          output: 'No expected type found at this position.',
        };
      }

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
    } catch (error) {
      return {
        summary: 'Failed to get term goal',
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}
