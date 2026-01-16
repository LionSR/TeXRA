// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';
import { executeCommand } from '@utils/system/execUtils';

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
      // Preserve empty lines to maintain error message readability
      currentDiagnostic.message += '\n' + line;
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
      if (currentGoal) goals.push(currentGoal);
      currentGoal = trimmed.slice(1).trim();
      inGoal = true;
    } else if (inGoal && trimmed) {
      currentGoal += ' ' + trimmed;
    } else if (trimmed.includes(':') && !inGoal) {
      context.push(trimmed);
    }
  }

  if (currentGoal) goals.push(currentGoal);
  return goals.length > 0 ? { goals, context } : null;
}

/**
 * Format diagnostics for readable output.
 */
function formatDiagnostics(diagnostics: LeanDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No errors or warnings.';

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const sections: string[] = [];

  // Extract and format goal states from errors
  const goalStates = extractGoalStates(errors);
  if (goalStates.length > 0) {
    sections.push(`## Unsolved Goals\n`);
    for (const gs of goalStates) {
      sections.push(`**Line ${gs.line}:**`);
      if (gs.context.length > 0) {
        sections.push('Context:');
        for (const ctx of gs.context) sections.push(`  ${ctx}`);
      }
      sections.push('Goals:');
      for (let i = 0; i < gs.goals.length; i++) {
        sections.push(`  ${i + 1}. ⊢ ${gs.goals[i]}`);
      }
      sections.push('');
    }
  }

  // Other errors (not unsolved goals)
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

  if (warnings.length > 0) {
    sections.push(`## Warnings (${warnings.length})\n`);
    for (const w of warnings) {
      sections.push(`**${w.file}:${w.line}:${w.column}**\n${w.message}\n`);
    }
  }

  return sections.join('\n');
}

// ============================================================================
// Tool Implementation: lake_build
// ============================================================================

/**
 * Validates a Lake build target to prevent command injection.
 * Valid targets: alphanumeric characters, dots, hyphens, underscores, forward slashes, colons.
 * Examples: "Mathlib", "Mathlib.Algebra", "MyProject/Basic", "@Mathlib", "Mathlib:Core"
 * Blocks: path traversal (..), home directory (~), shell metacharacters
 */
function isValidBuildTarget(target: string): boolean {
  // Allow: letters, numbers, @, ., _, -, /, :
  if (!/^[@a-zA-Z0-9._/:/-]+$/.test(target)) {
    return false;
  }
  // Block path traversal and home directory expansion
  if (target.includes('..') || target.includes('~')) {
    return false;
  }
  return true;
}

const LakeBuildInputSchema = z.strictObject({
  /** Specific target to build (optional, builds all if not specified) */
  target: z.string().nullish().describe('Specific target to build'),
  /** Working directory for the command (must contain lakefile.lean) */
  cwd: z.string().nullish().describe('Project directory with lakefile.lean'),
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

    // Validate target to prevent command injection
    if (target && !isValidBuildTarget(target)) {
      return {
        summary: 'Invalid build target',
        output: `Build target "${target}" contains invalid characters or patterns. ` +
          'Targets must only contain alphanumeric characters, dots, hyphens, underscores, forward slashes, colons, or @ prefix. ' +
          'Path traversal (..) and home directory (~) are not allowed.',
        isError: true,
      };
    }

    // Build command with optional JSON flag
    let command = 'lake build';
    if (json) {
      command += ' --json';
    }
    if (target) {
      command += ` ${target}`;
    }

    const result = await executeCommand(command, {
      cwd: cwd ?? undefined,
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
