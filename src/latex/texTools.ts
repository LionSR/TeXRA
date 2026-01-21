// Standard library imports
import * as path from 'path';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import {
  LaTeXCompileOptionsSchema,
  type LaTeXCompileOptions,
} from '@common/schemas';

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

/**
 * Compile a LaTeX file to PDF
 * @param latexLocation FileLocation for the LaTeX file
 * @param options Compilation options (channel defaults to module CHANNEL)
 * @returns Promise<boolean> True if compilation succeeded
 */
export async function compileLatex2Pdf(
  latexLocation: FileLocation,
  options: LaTeXCompileOptions = {},
): Promise<boolean> {
  // Schema provides compiler default; channel defaults to module constant
  const parsed = LaTeXCompileOptionsSchema.parse(options);
  const channel = parsed.channel ?? CHANNEL;
  const { outputDirectory, compiler } = parsed;
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
    const workspacePath = includeWorkspace ? WorkspaceFS.getPath() : null;
    const texInputParts = [
      '.',
      ...(workspacePath ? [workspacePath] : []),
      ...(tikzInputDirectory?.trim() ? [tikzInputDirectory] : []),
    ];

    // Build environment with TEXINPUTS if we have custom paths or existing TEXINPUTS
    const needsTexInputs = texInputParts.length > 1 || process.env.TEXINPUTS;
    const texInputs = needsTexInputs
      ? texInputParts.join(':') + ':' + (process.env.TEXINPUTS ?? '')
      : undefined;
    const env: Record<string, string> = {
      ...(texInputs && { TEXINPUTS: texInputs }),
    };
    if (texInputs) {
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
    if (compiler === 'latexmk') {
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
