// Standard library imports
import * as path from 'path';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { runToolWithCheck } from '@utils/system';
import { getConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
// No additional imports needed

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

// Tool configurations have been moved to utils/toolUtils.ts for centralized management

/**
 * Compile a LaTeX file to PDF
 * @param latexFile Path to the LaTeX file
 * @param channel Optional channel for logging
 * @param outputDirectory Directory for compiled PDF (default: alongside file)
 * @returns Promise<boolean> True if compilation succeeded
 */
export async function compileLatex2Pdf(
  latexFile: string,
  channel: string = CHANNEL,
  outputDirectory?: string,
  useLatexmk: boolean = false,
): Promise<boolean> {
  try {
    const outDir = outputDirectory || path.dirname(latexFile);
    await WorkspaceFS.createDir(outDir);

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

    // Create environment variables with TEXINPUTS if TikZ input directory is configured
    const env: Record<string, string> = {};

    // Start with the current directory
    let texInputs = '.:';

    // Add the workspace path if configured to do so
    if (includeWorkspace) {
      const workspacePath = WorkspaceFS.getPath();
      if (workspacePath) {
        texInputs += `${workspacePath}:`;
      }
    }

    // Add TikZ input directory if configured
    if (tikzInputDirectory && tikzInputDirectory.trim() !== '') {
      texInputs += `${tikzInputDirectory}:`;
    }

    // Append the existing TEXINPUTS if any
    if (process.env.TEXINPUTS) {
      texInputs += process.env.TEXINPUTS;
    }

    // Only set TEXINPUTS if we have something to set
    if (texInputs !== '.:') {
      env.TEXINPUTS = texInputs;
      logger.debug(channel, `Setting TEXINPUTS to: ${texInputs}`);
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
    logger.error(
      channel,
      `Error compiling LaTeX: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
