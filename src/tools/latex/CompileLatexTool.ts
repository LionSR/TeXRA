// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, type ToolResult } from '@tools/result';
import { buildTimeoutMessage } from '@tools/timeouts';
import { resolveAndFormat } from '@tools/utils';
import { defineTool } from '@tools/core/define';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { executeCommand } from '@utils/system/execUtils';

const COMPILE_TIMEOUT_MS = 120_000;

const CompileLatexInputSchema = z.strictObject({
  texPath: z
    .string()
    .min(1, 'texPath is required.')
    .describe('Path to the LaTeX file to compile.'),
  engine: z
    .enum(['pdflatex', 'xelatex', 'lualatex'])
    .nullish()
    .describe('LaTeX engine (default: pdflatex).'),
  clean: z
    .boolean()
    .nullish()
    .describe('Remove auxiliary files after compilation.'),
  timeout: z
    .number()
    .int()
    .min(5000)
    .max(600_000)
    .nullish()
    .describe(
      'Timeout in milliseconds (max 600,000 ms / 10 min, default 120,000 ms / 2 min).',
    ),
});

type CompileLatexInput = z.infer<typeof CompileLatexInputSchema>;

/** Maximum number of errors/warnings to include in output. */
const MAX_ERRORS = 30;
const MAX_WARNINGS = 20;

/**
 * Parse LaTeX log content to extract structured errors and warnings.
 */
function parseLatexLog(log: string): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = log.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // LaTeX errors start with '!'
    if (line.startsWith('!')) {
      let errorMsg = line;
      // Collect the following line reference (e.g., "l.42 \badcommand")
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (lines[j].startsWith('l.')) {
          errorMsg += '\n' + lines[j];
          break;
        }
      }
      errors.push(errorMsg);
    } else if (/^LaTeX Warning:/.test(line)) {
      warnings.push(line.trim());
    } else if (/^Package \S+ Warning:/.test(line)) {
      warnings.push(line.trim());
    }
  }

  return { errors, warnings };
}

export class CompileLatexTool extends defineTool({
  name: 'compile_latex',
  description:
    'Compile a LaTeX file to PDF using latexmk. Returns parsed errors and warnings from the compilation log. Use this to verify LaTeX output compiles correctly and to diagnose issues.',
  schema: CompileLatexInputSchema,
}) {
  protected async execute(input: CompileLatexInput): Promise<ToolResult> {
    const { path: resolvedPath, display } = resolveAndFormat(input.texPath);

    const exists = await WorkspaceFS.exists(resolvedPath.relative);
    if (!exists) {
      throw new ToolError(`LaTeX file not found: ${display}`);
    }

    if (!display.endsWith('.tex')) {
      throw new ToolError(`Expected a .tex file, got: ${display}`);
    }

    const engine = input.engine ?? 'pdflatex';
    const timeoutMs = input.timeout ?? COMPILE_TIMEOUT_MS;
    const dir = path.dirname(resolvedPath.absolute);
    const filename = path.basename(resolvedPath.absolute);

    // Map engine to latexmk flag
    const engineFlag =
      engine === 'xelatex'
        ? '-xelatex'
        : engine === 'lualatex'
          ? '-lualatex'
          : '-pdf';

    const result = await executeCommand(
      `latexmk ${engineFlag} -interaction=nonstopmode -file-line-error "${filename}"`,
      {
        truncate: true,
        timeout: timeoutMs,
        cwd: dir,
      },
    );

    if (result.timedOut) {
      throw new ToolError(buildTimeoutMessage('LaTeX compilation', timeoutMs));
    }

    // Try to read and parse the .log file for structured error info
    const logRelative = resolvedPath.relative.replace(/\.tex$/, '.log');
    let parsed: { errors: string[]; warnings: string[] } = {
      errors: [],
      warnings: [],
    };

    try {
      const logExists = await WorkspaceFS.exists(logRelative);
      if (logExists) {
        const buffer = await WorkspaceFS.readBytes(logRelative);
        parsed = parseLatexLog(buffer.toString('utf-8'));
      }
    } catch {
      // Fall back to parsing raw command output
    }

    // If no log file was parsed, try parsing the command output
    if (parsed.errors.length === 0 && parsed.warnings.length === 0) {
      const rawOutput = result.stdout || result.stderr || '';
      if (rawOutput) {
        parsed = parseLatexLog(rawOutput);
      }
    }

    // Clean auxiliary files if requested
    if (input.clean) {
      await executeCommand(`latexmk -c "${filename}"`, {
        truncate: true,
        timeout: 30_000,
        cwd: dir,
      });
    }

    if (result.success) {
      const parts: string[] = [`Compiled ${display} successfully.`];

      if (parsed.warnings.length > 0) {
        parts.push(`\nWarnings (${parsed.warnings.length}):`);
        const shown = parsed.warnings.slice(0, MAX_WARNINGS);
        for (const w of shown) {
          parts.push(`  ${w}`);
        }
        if (parsed.warnings.length > MAX_WARNINGS) {
          parts.push(`  ... and ${parsed.warnings.length - MAX_WARNINGS} more`);
        }
      }

      const pdfName = filename.replace(/\.tex$/, '.pdf');
      parts.push(`\nOutput: ${pdfName}`);

      return {
        summary: `Compiled ${display} (${parsed.warnings.length} warning${parsed.warnings.length !== 1 ? 's' : ''})`,
        output: parts.join('\n'),
      };
    }

    // Compilation failed
    const parts: string[] = [`Compilation of ${display} failed.`];

    if (parsed.errors.length > 0) {
      parts.push(`\nErrors (${parsed.errors.length}):`);
      const shown = parsed.errors.slice(0, MAX_ERRORS);
      for (const e of shown) {
        parts.push(e);
      }
      if (parsed.errors.length > MAX_ERRORS) {
        parts.push(`... and ${parsed.errors.length - MAX_ERRORS} more`);
      }
    }

    if (parsed.warnings.length > 0) {
      parts.push(`\nWarnings (${parsed.warnings.length}):`);
      const shown = parsed.warnings.slice(0, 10);
      for (const w of shown) {
        parts.push(`  ${w}`);
      }
    }

    // Include raw output if no structured errors were parsed
    if (parsed.errors.length === 0) {
      const rawOutput = [result.stderr, result.stdout]
        .filter(Boolean)
        .join('\n');
      if (rawOutput) {
        parts.push(`\nRaw output:\n${rawOutput.slice(0, 3000)}`);
      }
    }

    throw new ToolError(parts.join('\n'));
  }
}
