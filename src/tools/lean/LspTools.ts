// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import { toErrorMessage } from '@common/errors';
import { openFileInEditor } from '@frontend/vscode/vscodeEditor';
import {
  waitForDiagnosticsChange,
  countBySeverity,
  formatCounts,
  formatGroupedSections,
  DiagnosticSeverity,
} from '@frontend/vscode/vscodeDiagnostics';
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';
import { WorkspaceFS } from '@utils/files';

// Local imports - VS Code integration
import * as vscodeIntegration from './VscodeIntegration';

// ============================================================================
// Schema Definitions
// ============================================================================

const LeanDiagnosticsInputSchema = z.strictObject({
  /** Command: list for full messages, count for summary */
  command: z
    .enum(['list', 'count'])
    .prefault('list')
    .describe('Use "list" for full messages or "count" for summary only'),
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
});

export type LeanDiagnosticsInput = z.infer<typeof LeanDiagnosticsInputSchema>;

const LeanRestartInputSchema = z.strictObject({
  /** Path to the Lean file to restart */
  file: z.string().describe('Path to the .lean file to restart'),
});

export type LeanRestartInput = z.infer<typeof LeanRestartInputSchema>;

const LeanGoalInputSchema = z.strictObject({
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
  /** 1-indexed line number */
  line: z.number().int().min(1).describe('Line number (1-indexed)'),
  /** 1-indexed column number */
  column: z.number().int().min(1).prefault(1).describe('Column number (1-indexed, default: 1)'),
});

export type LeanGoalInput = z.infer<typeof LeanGoalInputSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

const NO_DIAGNOSTICS_HELP = `No errors, warnings, or hints for this file.

If you expected errors:
1. Check the Lean 4 output panel (import/dependency errors appear there)
2. Make sure the file is saved
3. Try \`lean_restart\` to refresh the Lean server
4. Verify the Lean 4 extension is active (look for goal state in the infoview)`;

/** Navigate editor to first error location if present. */
async function navigateToFirstError(
  filePath: string,
  diagnostics: vscode.Diagnostic[],
): Promise<void> {
  const firstError = diagnostics.find(
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  if (firstError) {
    await openFileInEditor(filePath, firstError.range.start.line + 1);
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get diagnostics for a Lean file from VS Code.
 */
export class LeanDiagnosticsTool extends defineTool({
  name: 'lean_diagnostics',
  description: `Get diagnostic messages (errors, warnings, info) for a Lean 4 file.

Commands:
- "list" (default): Full diagnostic messages with locations
- "count": Summary counts only (faster for checking if file compiles)

Returns diagnostics from the Lean 4 VS Code extension including:
- Compilation errors with location
- Type mismatches
- Unsolved goals
- Warnings and hints

Tips:
- If diagnostics seem stale, call lean_restart first to refresh the Lean server
- Import/dependency errors may only appear in the Lean 4 output panel

Requires: Lean 4 VS Code extension installed and active.`,
  schema: LeanDiagnosticsInputSchema,
}) {
  protected async execute(input: LeanDiagnosticsInput): Promise<ToolResult> {
    const { command, file } = input;

    try {
      const diagnostics = await this.fetchDiagnostics(file);
      if (!diagnostics) {
        return {
          summary: 'Failed to open file',
          output: `Could not open file: ${file}\n\nMake sure the file exists and is accessible.`,
          isError: true,
        };
      }

      await navigateToFirstError(file, diagnostics);

      const counts = countBySeverity(diagnostics);
      const countsStr = formatCounts(counts);

      if (diagnostics.length === 0) {
        return { summary: '✓ No diagnostics', output: NO_DIAGNOSTICS_HELP };
      }

      const baseDiagnostics = { ...counts, total: diagnostics.length };

      if (command === 'count') {
        return {
          summary: countsStr,
          output: `${file}: ${countsStr}`,
          diagnostics: baseDiagnostics,
        };
      }

      return {
        summary: countsStr,
        output: formatGroupedSections(diagnostics),
        diagnostics: { ...baseDiagnostics, details: diagnostics },
      };
    } catch (error) {
      return {
        summary: 'Failed to get diagnostics',
        output: `Error: ${toErrorMessage(error)}\n\nMake sure the Lean 4 VS Code extension is installed and active.`,
        isError: true,
      };
    }
  }

  /** Open file and wait for diagnostics to be published. */
  private async fetchDiagnostics(
    file: string,
  ): Promise<vscode.Diagnostic[] | null> {
    const uri = vscode.Uri.file(WorkspaceFS.toAbsolute(file));
    const diagnosticsWait = waitForDiagnosticsChange(uri, 10000);

    const openedPath = await openFileInEditor(file);
    if (!openedPath) return null;

    await diagnosticsWait;
    return vscodeIntegration.getDiagnostics(openedPath);
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
        output: `Error: ${toErrorMessage(error)}`,
        isError: true,
      };
    }
  }
}

/**
 * Get the proof goal state at a specific position in a Lean file.
 */
export class LeanGoalTool extends defineTool({
  name: 'lean_goal',
  description: `Get the proof goal state at a specific position in a Lean 4 file.

Returns the current proof goals (what needs to be proven) at the given line and column.
This is equivalent to what you see in the Lean InfoView when your cursor is at that position.

Use this to:
- See what goals remain to be proven at a tactic
- Understand the current proof state before choosing the next tactic
- Check if a proof step made progress

Returns:
- goals: Array of goal strings (e.g., ["⊢ n + 0 = n"])
- rendered: Markdown-formatted goal display

Line and column are 1-indexed (first line is 1, first column is 1).

Requires: Lean 4 VS Code extension installed and active.`,
  schema: LeanGoalInputSchema,
}) {
  protected async execute(input: LeanGoalInput): Promise<ToolResult> {
    const { file, line, column } = input;

    try {
      // Convert to 0-indexed for LSP
      const result = await vscodeIntegration.getGoalState(file, line - 1, column - 1);

      if (!result) {
        return {
          summary: 'No goal state',
          output: `Could not get goal state at ${file}:${line}:${column}

Possible reasons:
- The Lean 4 extension is not installed or active
- The position is not inside a tactic proof
- The file has not been processed yet (try lean_diagnostics first)`,
          isError: true,
        };
      }

      if (result.goals.length === 0) {
        return {
          summary: 'No goals',
          output: 'No goals at this position. The proof may be complete here.',
        };
      }

      return {
        summary: `${result.goals.length} goal${result.goals.length > 1 ? 's' : ''}`,
        output: result.rendered,
        goalState: {
          goals: result.goals,
          count: result.goals.length,
        },
      };
    } catch (error) {
      return {
        summary: 'Failed to get goal state',
        output: `Error: ${toErrorMessage(error)}

Make sure the Lean 4 VS Code extension is installed and the file is open.`,
        isError: true,
      };
    }
  }
}
