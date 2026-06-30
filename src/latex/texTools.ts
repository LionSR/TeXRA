// Standard library imports
import * as path from 'node:path';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import {
  LaTeXCompileOptionsSchema,
  type LaTeXCompileOptions,
} from '@common/schemas';
import * as logger from '@logger/logUtils';

// Local imports - utils
import type { FileLocation } from '@shared/schemas';
import { WorkspaceFS, flexibleFS, pathToLocation } from '@utils/files';
import { runToolWithCheck } from '@utils/system';
import { getConfig } from '@utils/config/configUtils';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

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
 * Build the kpathsea search-path overrides (TEXINPUTS / BIBINPUTS / BSTINPUTS)
 * for a LaTeX compile, prepending the workspace and TikZ input directories onto
 * any inherited values.
 *
 * The `env` seam keeps the `process.env` read injectable for tests; this is the
 * lone environment touch in this VS Code-free module. The subprocess still
 * inherits the rest of `process.env` via `executeCommand`'s `commandEnv`, so
 * these keys only override the three search paths that need prepending.
 */
export function buildLatexInputEnv(
  texInputParts: readonly string[],
  bibSearchParts: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const needsTexInputs = texInputParts.length > 1 || !!env.TEXINPUTS;
  const texInputs = needsTexInputs
    ? buildKpathseaSearchPath(texInputParts, env.TEXINPUTS)
    : undefined;
  const bibInputs = buildKpathseaSearchPath(bibSearchParts, env.BIBINPUTS);
  const bstInputs = buildKpathseaSearchPath(bibSearchParts, env.BSTINPUTS);
  return {
    ...(texInputs && { TEXINPUTS: texInputs }),
    ...(bibInputs && { BIBINPUTS: bibInputs }),
    ...(bstInputs && { BSTINPUTS: bstInputs }),
  };
}

/**
 * Compose the kpathsea search-path parts for a compile. The document's own
 * directory and any caller-supplied source directories come first — ahead of
 * `.` (the compiler's cwd, which is the workspace root, not the document's
 * folder) so a subfolder document's relative `\input{…}` resolves against its
 * own tree rather than a same-named file at the workspace root; the document
 * dir also precedes the extra source dirs so a revised sibling in run storage
 * beats the original-source fallback. The workspace root and TikZ dir follow.
 * Bibliography search omits `.` and TikZ — only directories that can hold
 * `.bib`/`.bst` matter there.
 */
export function buildLatexSearchParts(input: {
  documentDir: string;
  extraInputDirs?: readonly string[];
  workspacePath?: string | null;
  tikzInputDirectory?: string | null;
}): { texInputParts: string[]; bibSearchParts: string[] } {
  const { documentDir, extraInputDirs, workspacePath, tikzInputDirectory } =
    input;
  const sourceDirs = [documentDir, ...(extraInputDirs ?? [])];
  const workspaceParts = workspacePath ? [workspacePath] : [];
  const tikzParts = tikzInputDirectory?.trim() ? [tikzInputDirectory] : [];
  return {
    texInputParts: [...sourceDirs, '.', ...workspaceParts, ...tikzParts],
    bibSearchParts: [...sourceDirs, ...workspaceParts],
  };
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
  const { outputDirectory, compiler, timeout, extraInputDirs } = parsed;
  try {
    const latexFile = latexLocation.absolutePath;
    const outDir = outputDirectory ?? path.dirname(latexFile);
    await flexibleFS.ensureDir(pathToLocation(outDir));

    // TeX resolves relative `\input{…}` / `\bibliography{…}` against the
    // compiler's cwd and TEXINPUTS, not the main file's location. When a
    // run-storage document (round output or latexdiff) compiles from a build
    // directory, its own folder and any caller-supplied source directories must
    // be on the search path or `\input{preamble}`, `\input{figures/…}`, and the
    // bibliography fail to resolve. The file's own directory comes first so a
    // revised sibling wins over the original source fallback.
    const documentDir = path.dirname(latexFile);

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
    const { texInputParts, bibSearchParts } = buildLatexSearchParts({
      documentDir,
      extraInputDirs,
      workspacePath,
      tikzInputDirectory,
    });

    // Build kpathsea search-path overrides, prepending workspace/TikZ dirs onto
    // any inherited values. `path.delimiter` keeps it cross-platform.
    const env = buildLatexInputEnv(texInputParts, bibSearchParts);
    for (const key of ['TEXINPUTS', 'BIBINPUTS', 'BSTINPUTS'] as const) {
      const value = env[key];
      if (value) {
        logger.debug(channel, `Setting ${key} to: ${value}`);
      }
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
