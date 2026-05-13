// Standard library imports
import * as path from 'path';

// Local imports - common
import * as logger from '@agent/core/logger';
import { getConfig } from '@agent/core/config';
import { toErrorMessage } from '@common/errors';
import {
  LaTeXCompileOptionsSchema,
  type LaTeXCompileOptions,
} from '@common/schemas';

// Local imports - log

// Local imports - utils
import { WorkspaceFS, flexibleFS, pathToLocation } from '@utils/files';
import type { FileLocation } from '@utils/files';
import { runToolWithCheck } from '@utils/system';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

// Tool configurations have been moved to utils/toolUtils.ts for centralized management

export function buildKpathseaSearchPath(
  prependPaths: readonly string[],
  existingValue: string | undefined = undefined,
  delimiter: string = path.delimiter,
): string | undefined {
  const prefix = prependPaths
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(delimiter);
  if (!prefix) return undefined;

  const value = existingValue
    ? `${prefix}${delimiter}${existingValue}`
    : prefix;
  return value.endsWith(delimiter) ? value : `${value}${delimiter}`;
}

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
  const { outputDirectory, compiler, timeout } = parsed;
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
    // Use path.delimiter for cross-platform compatibility (`:` on Unix, `;` on Windows)
    const needsTexInputs = texInputParts.length > 1 || process.env.TEXINPUTS;
    const texInputs = needsTexInputs
      ? buildKpathseaSearchPath(texInputParts, process.env.TEXINPUTS)
      : undefined;
    const bibSearchParts = workspacePath ? [workspacePath] : [];
    const bibInputs = buildKpathseaSearchPath(
      bibSearchParts,
      process.env.BIBINPUTS,
    );
    const bstInputs = buildKpathseaSearchPath(
      bibSearchParts,
      process.env.BSTINPUTS,
    );
    const env: Record<string, string> = {
      ...(texInputs && { TEXINPUTS: texInputs }),
      ...(bibInputs && { BIBINPUTS: bibInputs }),
      ...(bstInputs && { BSTINPUTS: bstInputs }),
    };
    if (texInputs) {
      logger.debug(channel, `Setting TEXINPUTS to: ${texInputs}`);
    }
    if (bibInputs) {
      logger.debug(channel, `Setting BIBINPUTS to: ${bibInputs}`);
    }
    if (bstInputs) {
      logger.debug(channel, `Setting BSTINPUTS to: ${bstInputs}`);
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
        timeout,
        showError: false, // Suppress error for latexmk to try pdflatex as fallback
      });
      if (!result) {
        logger.warn(
          channel,
          'latexmk not found, falling back to single-pass pdflatex — ' +
            'bibliography, cross-references, and index may be incomplete',
        );
        result = await runToolWithCheck('pdflatex', pdflatexArgs, {
          channel,
          env,
          timeout,
          showError: true, // Show error if pdflatex also fails
        });
      }
    } else {
      result = await runToolWithCheck('pdflatex', pdflatexArgs, {
        channel,
        env,
        timeout,
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
