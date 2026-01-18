// Standard library imports
import * as path from 'path';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import { LaTeXCompileOptionsSchema } from '@common/schemas';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utils
import { getConfig } from '@utils/config';
import { WorkspaceFS, flexibleFS, pathToLocation } from '@utils/files';
import type { FileLocation } from '@utils/files';
import { runToolWithCheck } from '@utils/system';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

// Tool configurations have been moved to utils/toolUtils.ts for centralized management

export interface LaTeXCompileOptions {
  /** Channel for logging */
  channel?: string;
  /** Output directory for compiled PDF */
  outputDirectory?: string;
  /** Compiler to use: 'pdflatex' or 'latexmk' */
  compiler?: 'pdflatex' | 'latexmk';
}

/**
 * Compile a LaTeX file to PDF
 * @param latexLocation FileLocation for the LaTeX file
 * @param options Compilation options
 * @returns Promise<boolean> True if compilation succeeded
 */
export async function compileLatex2Pdf(
  latexLocation: FileLocation,
  options: LaTeXCompileOptions = {},
): Promise<boolean> {
  // Schema provides defaults
  const parsed = LaTeXCompileOptionsSchema.parse(options);
  const channel = parsed.channel ?? CHANNEL;
  const outputDirectory = parsed.outputDirectory;
  const useLatexmk = parsed.compiler === 'latexmk';
  try {
    const latexFile = latexLocation.absolutePath;
    const outDir = outputDirectory ?? path.dirname(latexFile);
    await flexibleFS.ensureDir(pathToLocation(outDir));

    // Get TikZ input directory from configuration
    const tikzInputDirectory = getConfig<string>(
      'texra.latex.tikzInputDirectory',
      '',
    );

    // Check if workspace path should be included
    const includeWorkspace = getConfig<boolean>(
      'texra.latex.includeWorkspaceInTexinputs',
      true,
    );

    // Build TEXINPUTS from configured paths
    const texInputParts = ['.'];
    if (includeWorkspace) {
      const workspacePath = WorkspaceFS.getPath();
      if (workspacePath) texInputParts.push(workspacePath);
    }
    if (tikzInputDirectory?.trim()) {
      texInputParts.push(tikzInputDirectory);
    }

    const env: Record<string, string> = {};
    if (texInputParts.length > 1 || process.env.TEXINPUTS) {
      // Build base path, append existing TEXINPUTS verbatim (preserving its trailing colon behavior)
      let texInputs = texInputParts.join(':') + ':';
      if (process.env.TEXINPUTS) {
        texInputs += process.env.TEXINPUTS;
      }
      env.TEXINPUTS = texInputs;
      logger.debug(channel, `Setting TEXINPUTS to: ${env.TEXINPUTS}`);
    }

    const latexmkArgs = [
      '-pdf',
      '-f',
      '-interaction=nonstopmode',
      `-output-directory=${outDir}`,
      latexFile,
    ];

    const pdflatexArgs = [
      '-interaction=nonstopmode',
      `-output-directory=${outDir}`,
      latexFile,
    ];

    let result: Awaited<ReturnType<typeof runToolWithCheck>>;
    if (useLatexmk) {
      result = await runToolWithCheck('latexmk', latexmkArgs, {
        channel,
        env,
        showError: false, // Suppress error for latexmk to try pdflatex as fallback
      });
      if (!result) {
        result = await runToolWithCheck('pdflatex', pdflatexArgs, {
          channel,
          env,
          showError: true, // Show error if pdflatex also fails
        });
      }
    } else {
      result = await runToolWithCheck('pdflatex', pdflatexArgs, {
        channel,
        env,
        showError: true, // Show error for missing pdflatex
      });
    }

    if (result && result.success) {
      logger.debug(channel, `Successfully compiled ${latexFile}`);
      return true;
    }
    return false;
  } catch (err) {
    logger.error(channel, `Error compiling LaTeX: ${toErrorMessage(err)}`);
    return false;
  }
}
