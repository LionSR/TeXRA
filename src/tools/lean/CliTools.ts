// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolResult, ToolError } from '@tools/result';
import { executeCommand } from '@utils/system/execUtils';

// Local file imports
import { defineTool } from '@tools/core/define';

// ============================================================================
// Schema Definitions
// ============================================================================

const LeanCheckInputSchema = z.strictObject({
  /** Path to the Lean file to check (relative to workspace or absolute) */
  file: z.string().describe('Path to the .lean file to check'),
  /** Whether to use lake env for project context (enables imports from lakefile) */
  useProjectContext: z
    .boolean()
    .prefault(false)
    .describe('Use lake env for project imports'),
  /** Working directory for the command (defaults to workspace root) */
  cwd: z.string().optional().describe('Working directory for the command'),
  /** Include info messages (goal states from sorry, #check output, etc.) */
  includeInfo: z
    .boolean()
    .prefault(true)
    .describe('Include info messages like goal states'),
});

export type LeanCheckInput = z.infer<typeof LeanCheckInputSchema>;

// ============================================================================
// Types
// ============================================================================

interface LeanDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** Goal state extracted from Lean's unsolved goals message */
interface GoalState {
  line: number;
  column: number;
  goals: string[];
  context: string[];
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse Lean 4 compiler output into structured diagnostics.
 * Lean 4 error format: file:line:col[-endLine:endCol]: severity: message
 * Multi-line messages are indented with spaces.
 */
function parseLeanOutput(output: string): LeanDiagnostic[] {
  const diagnostics: LeanDiagnostic[] = [];
  const lines = output.split('\n');

  // Regex for Lean 4 error format: file:line:col[-endLine:endCol]: severity: message
  const diagnosticPattern =
    /^(.+?):(\d+):(\d+)(?:-(\d+):(\d+))?:\s*(error|warning|info):\s*(.*)$/;

  let currentDiagnostic: LeanDiagnostic | null = null;

  for (const line of lines) {
    const match = line.match(diagnosticPattern);
    if (match) {
      // Save previous diagnostic if exists
      if (currentDiagnostic) {
        diagnostics.push(currentDiagnostic);
      }

      currentDiagnostic = {
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        endLine: match[4] ? parseInt(match[4], 10) : undefined,
        endColumn: match[5] ? parseInt(match[5], 10) : undefined,
        severity: match[6] as 'error' | 'warning' | 'info',
        message: match[7],
      };
    } else if (currentDiagnostic && (line.startsWith('  ') || line === '')) {
      // Continuation of multi-line message (indented or empty line within message)
      if (line !== '') {
        currentDiagnostic.message += '\n' + line;
      }
    }
  }

  // Don't forget the last diagnostic
  if (currentDiagnostic) {
    diagnostics.push(currentDiagnostic);
  }

  return diagnostics;
}

/**
 * Extract goal states from "unsolved goals" error messages.
 * These contain the current proof context and remaining goals.
 */
function extractGoalStates(diagnostics: LeanDiagnostic[]): GoalState[] {
  const goalStates: GoalState[] = [];

  for (const diag of diagnostics) {
    if (diag.message.includes('unsolved goals')) {
      const goalState = parseGoalMessage(diag);
      if (goalState) {
        goalStates.push({
          ...goalState,
          line: diag.line,
          column: diag.column,
        });
      }
    }
  }

  return goalStates;
}

/**
 * Parse a goal message to extract context and goals.
 * Format:
 * unsolved goals
 * case ...
 * context_var : Type
 * ⊢ goal_type
 */
function parseGoalMessage(
  diag: LeanDiagnostic,
): { goals: string[]; context: string[] } | null {
  const lines = diag.message.split('\n');
  const context: string[] = [];
  const goals: string[] = [];

  let inGoal = false;
  let currentGoal = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'unsolved goals') continue;
    if (trimmed.startsWith('case ')) continue;

    if (trimmed.startsWith('⊢')) {
      // Start of a goal
      if (currentGoal) {
        goals.push(currentGoal);
      }
      currentGoal = trimmed.slice(1).trim();
      inGoal = true;
    } else if (inGoal && trimmed) {
      // Continuation of goal
      currentGoal += ' ' + trimmed;
    } else if (trimmed.includes(':') && !inGoal) {
      // Context variable
      context.push(trimmed);
    }
  }

  if (currentGoal) {
    goals.push(currentGoal);
  }

  return goals.length > 0 ? { goals, context } : null;
}

/**
 * Format diagnostics for readable output.
 */
function formatDiagnostics(
  diagnostics: LeanDiagnostic[],
  includeInfo: boolean = true,
): string {
  if (diagnostics.length === 0) {
    return 'No errors or warnings.';
  }

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const infos = includeInfo
    ? diagnostics.filter((d) => d.severity === 'info')
    : [];

  const sections: string[] = [];

  // Extract and format goal states from errors
  const goalStates = extractGoalStates(errors);
  if (goalStates.length > 0) {
    sections.push(`## Unsolved Goals\n`);
    for (const gs of goalStates) {
      sections.push(`**Line ${gs.line}:**`);
      if (gs.context.length > 0) {
        sections.push('Context:');
        for (const ctx of gs.context) {
          sections.push(`  ${ctx}`);
        }
      }
      sections.push('Goals:');
      for (let i = 0; i < gs.goals.length; i++) {
        sections.push(`  ${i + 1}. ⊢ ${gs.goals[i]}`);
      }
      sections.push('');
    }
  }

  if (errors.length > 0) {
    // Filter out "unsolved goals" which we've already formatted
    const otherErrors = errors.filter(
      (e) => !e.message.includes('unsolved goals'),
    );
    if (otherErrors.length > 0) {
      sections.push(`## Errors (${otherErrors.length})\n`);
      for (const err of otherErrors) {
        sections.push(
          `**${err.file}:${err.line}:${err.column}**\n${err.message}\n`,
        );
      }
    }
  }

  if (warnings.length > 0) {
    sections.push(`## Warnings (${warnings.length})\n`);
    for (const warn of warnings) {
      sections.push(
        `**${warn.file}:${warn.line}:${warn.column}**\n${warn.message}\n`,
      );
    }
  }

  if (infos.length > 0) {
    sections.push(`## Info (${infos.length})\n`);
    for (const info of infos) {
      sections.push(
        `**${info.file}:${info.line}:${info.column}**\n${info.message}\n`,
      );
    }
  }

  return sections.join('\n');
}

// ============================================================================
// Tool Implementation: lean_check
// ============================================================================

export class LeanCheckTool extends defineTool({
  name: 'lean_check',
  description: `Check a Lean 4 file for errors. Returns structured diagnostic output including errors, warnings, goal states, and info messages.

Usage:
- Basic check: lean_check with file path
- With project imports: set useProjectContext=true to use lake env
- Include #check/#print output: includeInfo=true (default)

Returns:
- Success: "✓ File compiled successfully" with any warnings
- Failure: Structured list with:
  - Unsolved goals (formatted with context and goal types)
  - Other errors with file location
  - Warnings and info messages

Goal State Output:
When proofs have unsolved goals, the tool extracts and formats them:
- Context variables with their types
- Numbered list of goals to prove

Tips for iterating on proofs:
- Use \`sorry\` as a placeholder to see goal state at that point
- Use \`#check expr\` to see the type of an expression
- Use \`#print theorem_name\` to see a theorem's statement`,
  schema: LeanCheckInputSchema,
}) {
  protected async execute(input: LeanCheckInput): Promise<ToolResult> {
    const { file, useProjectContext, cwd, includeInfo } = input;

    // Validate file extension
    if (!file.endsWith('.lean')) {
      throw new ToolError(`File must have .lean extension: ${file}`);
    }

    // Build command - use lake env for project context
    const command = useProjectContext
      ? `lake env lean "${file}"`
      : `lean "${file}"`;

    // Execute
    const result = await executeCommand(command, {
      cwd,
      truncate: false, // We want full output for error parsing
    });

    // Parse output (errors go to stderr, but we check both)
    const combinedOutput = [result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n');
    const diagnostics = parseLeanOutput(combinedOutput);

    const errors = diagnostics.filter((d) => d.severity === 'error');
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    const infos = diagnostics.filter((d) => d.severity === 'info');
    const goalStates = extractGoalStates(errors);

    if (result.success && errors.length === 0) {
      // Success case
      const summary =
        warnings.length > 0
          ? `✓ Compiled with ${warnings.length} warning(s)`
          : '✓ File compiled successfully';

      return {
        summary,
        output:
          warnings.length > 0 || (includeInfo && infos.length > 0)
            ? formatDiagnostics(diagnostics, includeInfo)
            : 'No errors or warnings.',
        diagnostics: {
          errors: 0,
          warnings: warnings.length,
          infos: infos.length,
        },
      };
    }

    // Error case - return structured output but don't throw
    // This allows the agent to see and iterate on errors
    return {
      summary: `✗ ${errors.length} error(s), ${warnings.length} warning(s)${goalStates.length > 0 ? `, ${goalStates.length} unsolved goal(s)` : ''}`,
      output: formatDiagnostics(diagnostics, includeInfo),
      isError: true,
      diagnostics: {
        errors: errors.length,
        warnings: warnings.length,
        infos: infos.length,
        unsolvedGoals: goalStates.length,
        goalStates,
        details: diagnostics,
      },
    };
  }
}

// ============================================================================
// Tool Implementation: lake_build
// ============================================================================

const LakeBuildInputSchema = z.strictObject({
  /** Specific target to build (optional, builds all if not specified) */
  target: z.string().optional().describe('Specific target to build'),
  /** Working directory for the command (must contain lakefile.lean) */
  cwd: z.string().optional().describe('Project directory with lakefile.lean'),
  /** Use JSON output format for structured results */
  json: z.boolean().prefault(false).describe('Output results as JSON'),
});

export type LakeBuildInput = z.infer<typeof LakeBuildInputSchema>;

export class LakeBuildTool extends defineTool({
  name: 'lake_build',
  description: `Build a Lean 4 project using Lake. Must be run in a directory with lakefile.lean.

Usage:
- Build all: lake_build with no target
- Build specific: lake_build with target name
- JSON output: set json=true for structured results

Note: First build may take a long time if dependencies need to be fetched.
Use \`lake exe cache get\` first for Mathlib projects to download prebuilt oleans.`,
  schema: LakeBuildInputSchema,
}) {
  protected async execute(input: LakeBuildInput): Promise<ToolResult> {
    const { target, cwd, json } = input;

    // Build command with optional JSON flag
    let command = 'lake build';
    if (json) {
      command += ' --json';
    }
    if (target) {
      command += ` ${target}`;
    }

    const result = await executeCommand(command, {
      cwd,
      truncate: true,
      timeout: 300000, // 5 minutes for builds
    });

    const combinedOutput = [result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n');

    if (result.success) {
      // Try to parse JSON output if requested
      if (json && result.stdout) {
        try {
          const jsonResult = JSON.parse(result.stdout);
          return {
            summary: target ? `✓ Built ${target}` : '✓ Build successful',
            output: JSON.stringify(jsonResult, null, 2),
            diagnostics: { json: true, result: jsonResult },
          };
        } catch {
          // Fall through to regular output
        }
      }

      return {
        summary: target ? `✓ Built ${target}` : '✓ Build successful',
        output: combinedOutput || 'Build completed with no output.',
      };
    }

    // Parse build errors
    const diagnostics = parseLeanOutput(combinedOutput);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const goalStates = extractGoalStates(errors);

    return {
      summary: `✗ Build failed with ${errors.length} error(s)${goalStates.length > 0 ? `, ${goalStates.length} unsolved goal(s)` : ''}`,
      output: formatDiagnostics(diagnostics) || combinedOutput,
      isError: true,
      diagnostics: {
        errors: errors.length,
        unsolvedGoals: goalStates.length,
        goalStates,
        details: diagnostics,
      },
    };
  }
}

// ============================================================================
// Tool Implementation: lean_goal (extract goal state at a position)
// ============================================================================

const LeanGoalInputSchema = z.strictObject({
  /** Path to the Lean file */
  file: z.string().describe('Path to the .lean file'),
  /** Line number (1-indexed) */
  line: z.number().describe('Line number to check (1-indexed)'),
  /** Column number (1-indexed, optional) */
  column: z.number().optional().describe('Column number (1-indexed)'),
  /** Working directory */
  cwd: z.string().optional().describe('Working directory'),
});

export type LeanGoalInput = z.infer<typeof LeanGoalInputSchema>;

export class LeanGoalTool extends defineTool({
  name: 'lean_goal',
  description: `Get the proof goal state at a specific location in a Lean 4 file (CLI-based).

This tool compiles the file and extracts goal states from compiler output.
For real-time goal information without compilation, use lean_lsp_goal instead.

Usage:
- Specify the file and line number
- Optionally specify column for more precision

Tips:
- Add \`sorry\` at a position to see the goal state there
- Use \`#check expr\` to see expression types`,
  schema: LeanGoalInputSchema,
}) {
  protected async execute(input: LeanGoalInput): Promise<ToolResult> {
    const { file, line, cwd } = input;

    const command = `lean "${file}"`;
    const result = await executeCommand(command, {
      cwd,
      truncate: false,
    });

    const combinedOutput = [result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n');
    const diagnostics = parseLeanOutput(combinedOutput);

    // Find diagnostics at or near the specified line
    const nearbyDiags = diagnostics.filter((d) => Math.abs(d.line - line) <= 2);
    const goalStates = extractGoalStates(nearbyDiags);

    if (goalStates.length > 0) {
      const gs = goalStates[0];
      let output = `## Goal State at Line ${line}\n\n`;

      if (gs.context.length > 0) {
        output += '**Context:**\n';
        for (const ctx of gs.context) {
          output += `  ${ctx}\n`;
        }
        output += '\n';
      }

      output += '**Goals:**\n';
      for (let i = 0; i < gs.goals.length; i++) {
        output += `  ${i + 1}. ⊢ ${gs.goals[i]}\n`;
      }

      return {
        summary: `Found ${gs.goals.length} goal(s) at line ${line}`,
        output,
        diagnostics: { goalState: gs },
      };
    }

    // Check for other info at this line
    const infoAtLine = nearbyDiags.filter((d) => d.severity === 'info');
    if (infoAtLine.length > 0) {
      return {
        summary: `Found info at line ${line}`,
        output: infoAtLine.map((d) => d.message).join('\n\n'),
        diagnostics: { infos: infoAtLine },
      };
    }

    return {
      summary: `No goal state found at line ${line}`,
      output:
        'No unsolved goals or info messages found near this location.\n' +
        'Try adding `sorry` at this position to see the goal state,\n' +
        'or use lean_lsp_goal for real-time goal information.',
    };
  }
}
