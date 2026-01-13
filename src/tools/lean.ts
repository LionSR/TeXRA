// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolResult, ToolError } from '@tools/result';
import { executeCommand } from '@utils/system/execUtils';

// Local file imports
import { defineTool } from './core/define';

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
  cwd: z
    .string()
    .optional()
    .describe('Working directory for the command'),
});

export type LeanCheckInput = z.infer<typeof LeanCheckInputSchema>;

// ============================================================================
// Error Parsing
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

/**
 * Parse Lean 4 compiler output into structured diagnostics.
 * Lean 4 error format: file:line:col: severity: message
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
    } else if (currentDiagnostic && line.startsWith('  ')) {
      // Continuation of multi-line message
      currentDiagnostic.message += '\n' + line.trim();
    }
  }

  // Don't forget the last diagnostic
  if (currentDiagnostic) {
    diagnostics.push(currentDiagnostic);
  }

  return diagnostics;
}

/**
 * Format diagnostics for readable output.
 */
function formatDiagnostics(diagnostics: LeanDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return 'No errors or warnings.';
  }

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const infos = diagnostics.filter((d) => d.severity === 'info');

  const sections: string[] = [];

  if (errors.length > 0) {
    sections.push(`## Errors (${errors.length})\n`);
    for (const err of errors) {
      sections.push(
        `**${err.file}:${err.line}:${err.column}**\n${err.message}\n`,
      );
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
// Tool Implementation
// ============================================================================

export class LeanCheckTool extends defineTool({
  name: 'lean_check',
  description: `Check a Lean 4 file for errors. Returns structured diagnostic output including errors, warnings, and proof state information.

Usage:
- Basic check: lean_check with file path
- With project imports: set useProjectContext=true to use lake env

Returns:
- Success: "✓ File compiled successfully" with any warnings
- Failure: Structured list of errors with file location and message

Common error types:
- "unknown identifier": Missing import or undefined name
- "type mismatch": Wrong type, check with #check
- "unsolved goals": Proof incomplete, needs more tactics`,
  schema: LeanCheckInputSchema,
}) {
  protected async execute(input: LeanCheckInput): Promise<ToolResult> {
    const { file, useProjectContext, cwd } = input;

    // Validate file extension
    if (!file.endsWith('.lean')) {
      throw new ToolError(`File must have .lean extension: ${file}`);
    }

    // Build command
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

    if (result.success && errors.length === 0) {
      // Success case
      const summary =
        warnings.length > 0
          ? `✓ Compiled with ${warnings.length} warning(s)`
          : '✓ File compiled successfully';

      return {
        summary,
        output:
          warnings.length > 0
            ? formatDiagnostics(diagnostics)
            : 'No errors or warnings.',
        diagnostics: { errors: 0, warnings: warnings.length },
      };
    }

    // Error case - return structured output but don't throw
    // This allows the agent to see and iterate on errors
    return {
      summary: `✗ ${errors.length} error(s), ${warnings.length} warning(s)`,
      output: formatDiagnostics(diagnostics),
      isError: true,
      diagnostics: {
        errors: errors.length,
        warnings: warnings.length,
        details: diagnostics,
      },
    };
  }
}

// ============================================================================
// Lake Build Tool
// ============================================================================

const LakeBuildInputSchema = z.strictObject({
  /** Specific target to build (optional, builds all if not specified) */
  target: z.string().optional().describe('Specific target to build'),
  /** Working directory for the command (must contain lakefile.lean) */
  cwd: z.string().optional().describe('Project directory with lakefile.lean'),
});

export type LakeBuildInput = z.infer<typeof LakeBuildInputSchema>;

export class LakeBuildTool extends defineTool({
  name: 'lake_build',
  description: `Build a Lean 4 project using Lake. Must be run in a directory with lakefile.lean.

Usage:
- Build all: lake_build with no target
- Build specific: lake_build with target name

Note: First build may take a long time if dependencies need to be fetched.`,
  schema: LakeBuildInputSchema,
}) {
  protected async execute(input: LakeBuildInput): Promise<ToolResult> {
    const { target, cwd } = input;

    const command = target ? `lake build ${target}` : 'lake build';

    const result = await executeCommand(command, {
      cwd,
      truncate: true,
      timeout: 300000, // 5 minutes for builds
    });

    const combinedOutput = [result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n');

    if (result.success) {
      return {
        summary: target ? `✓ Built ${target}` : '✓ Build successful',
        output: combinedOutput || 'Build completed with no output.',
      };
    }

    // Parse build errors
    const diagnostics = parseLeanOutput(combinedOutput);
    const errors = diagnostics.filter((d) => d.severity === 'error');

    return {
      summary: `✗ Build failed with ${errors.length} error(s)`,
      output: formatDiagnostics(diagnostics) || combinedOutput,
      isError: true,
      diagnostics: {
        errors: errors.length,
        details: diagnostics,
      },
    };
  }
}
