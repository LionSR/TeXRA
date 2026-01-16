// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';
import { executeCommand } from '@utils/system/execUtils';

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
  // Block: path traversal (..) and home directory (~)
  return (
    /^[@a-zA-Z0-9._/:/-]+$/.test(target) &&
    !target.includes('..') &&
    !target.includes('~')
  );
}

const LakeBuildInputSchema = z.strictObject({
  /** Specific target to build (optional, builds all if not specified) */
  target: z.string().nullish().describe('Specific target to build'),
  /** Working directory for the command (must contain lakefile.lean) */
  cwd: z.string().nullish().describe('Project directory with lakefile.lean'),
});

export type LakeBuildInput = z.infer<typeof LakeBuildInputSchema>;

export class LakeBuildTool extends defineTool({
  name: 'lake_build',
  description: `Build a Lean 4 project using Lake. Must be run in a directory with lakefile.lean.

Usage:
- Build all: lake_build with no target
- Build specific: lake_build with target name

After a failed build, use lean_diagnostics to get structured error information.

Note: First build may take a long time if dependencies need to be fetched.
Use \`lake exe cache get\` first for Mathlib projects to download prebuilt oleans.`,
  schema: LakeBuildInputSchema,
}) {
  protected async execute(input: LakeBuildInput): Promise<ToolResult> {
    const { target, cwd } = input;

    // Validate target to prevent command injection
    if (target && !isValidBuildTarget(target)) {
      return {
        summary: 'Invalid build target',
        output:
          `Build target "${target}" contains invalid characters or patterns. ` +
          'Targets must only contain alphanumeric characters, dots, hyphens, underscores, forward slashes, colons, or @ prefix. ' +
          'Path traversal (..) and home directory (~) are not allowed.',
        isError: true,
      };
    }

    const command = target ? `lake build ${target}` : 'lake build';

    const result = await executeCommand(command, {
      cwd: cwd ?? undefined,
      truncate: true,
      timeout: 300000, // 5 minutes for builds
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

    if (result.success) {
      return {
        summary: target ? `✓ Built ${target}` : '✓ Build successful',
        output: output || 'Build completed successfully.',
      };
    }

    // Return raw build output - use lean_diagnostics for structured errors
    return {
      summary: '✗ Build failed',
      output: output || 'Build failed with no output.',
      isError: true,
    };
  }
}
