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

export class CompileLatexTool extends defineTool({
  name: 'compile_latex',
  description:
    'Compile a LaTeX file to PDF using latexmk. Returns compilation output including any errors or warnings.',
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

    const engineFlag =
      engine === 'xelatex'
        ? '-xelatex'
        : engine === 'lualatex'
          ? '-lualatex'
          : '-pdf';

    const result = await executeCommand(
      `latexmk ${engineFlag} -interaction=nonstopmode -file-line-error "${filename}"`,
      { truncate: true, timeout: timeoutMs, cwd: dir },
    );

    if (result.timedOut) {
      throw new ToolError(buildTimeoutMessage('LaTeX compilation', timeoutMs));
    }

    if (input.clean) {
      await executeCommand(`latexmk -c "${filename}"`, {
        truncate: true,
        timeout: 30_000,
        cwd: dir,
      });
    }

    if (result.success) {
      const pdfName = filename.replace(/\.tex$/, '.pdf');
      return {
        summary: `Compiled ${display} → ${pdfName}`,
        output: result.stdout || `Compiled successfully. Output: ${pdfName}`,
      };
    }

    const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new ToolError(
      output.slice(0, 4000) || `Compilation of ${display} failed.`,
    );
  }
}
