// Node imports
import * as path from 'node:path';

// External imports
import { z } from 'zod';

// Local imports
import { createLog } from '@logger/logUtils';
import type { ExecResult, FileLocation } from '@shared/schemas';
import { SUPPORTED_LATEX_COMPILERS } from '@shared/constants/latexToolchain';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';
import { splitContentLines } from '@utils/text/stringUtils';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from './latexLogging';

// Raw tail, no TeX-log parsing -- a deliberate choice (see compileCheck.ts):
// tex compile logs are noisy and heuristic parsing is a losing game, so every
// caller gets the same last-N-lines excerpt an LLM or a human can read as-is.
const LOG_TAIL_LINES = 200;

/**
 * Options for LaTeX compilation, used by {@link compileLatex2Pdf}.
 */
const LaTeXCompileOptionsSchema = z.object({
  channel: z.string().optional(),
  outputDirectory: z.string().optional(),
  compiler: z.enum(SUPPORTED_LATEX_COMPILERS).default('latexmk'),
  /** Millisecond timeout per compiler invocation. Kills the child on expiry. */
  timeout: z.int().positive().optional(),
  /**
   * Extra directories to prepend onto the kpathsea search path (TEXINPUTS /
   * BIBINPUTS / BSTINPUTS), after the main file's own directory and before the
   * workspace root. Used when a run-storage document compiles outside its
   * original location so relative `\input{…}` / `\bibliography{…}` targets
   * (e.g. `figures/fig.tex`, `library.bib`) still resolve against the original
   * source directory.
   */
  extraInputDirs: z.array(z.string()).default([]),
});

/** Input type - compiler optional with default applied by schema.parse() */
type LaTeXCompileOptions = z.input<typeof LaTeXCompileOptionsSchema>;

/**
 * Read the tail of the `.log` file a LaTeX engine drops next to its output
 * (`<basename-without-ext>.log` inside `outDir`). Shared by every
 * {@link compileLatex2Pdf} caller so a failed compile always comes with
 * enough context to act on, not just a boolean.
 */
async function readCompileLogTail(
  outDir: string,
  latexFile: string,
): Promise<string> {
  // Strip whatever extension the source actually has (.tex/.ltx/.latex are
  // all compilable, per isLatexFile) — the engine's .log file is always
  // named after the source with its own extension removed, not just .tex.
  const compiledBasename = path.basename(latexFile, path.extname(latexFile));
  const logAbs = path.join(outDir, `${compiledBasename}.log`);
  try {
    const full = await AbsoluteFS.read(logAbs);
    return splitContentLines(full).slice(-LOG_TAIL_LINES).join('\n');
  } catch (err) {
    return `(no LaTeX log at ${logAbs}: ${toErrorMessage(err)})`;
  }
}

export function buildKpathseaSearchPath(
  prependPaths: readonly string[],
  existingValue: string | undefined,
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
 * Result of a {@link compileLatex2Pdf} attempt. A discriminated union on `ok`
 * so the type system guarantees {@link LOG_TAIL_LINES}'s worth of the
 * engine's `.log` file tail is present whenever compilation fails, instead of
 * every caller needing a defensive fallback for a theoretically-missing
 * `logTail`.
 */
export type CompileLatex2PdfResult =
  { ok: true } | { ok: false; logTail: string };

/**
 * Compile a LaTeX file to PDF
 * @param latexLocation FileLocation for the LaTeX file
 * @param options Compilation options (channel defaults to module CHANNEL)
 * @returns `{ ok: true } | { ok: false, logTail }` -- `logTail` is always
 * populated on failure.
 */
export async function compileLatex2Pdf(
  latexLocation: FileLocation,
  options: LaTeXCompileOptions = {},
): Promise<CompileLatex2PdfResult> {
  // Schema provides compiler default; channel defaults to module constant
  const parsed = LaTeXCompileOptionsSchema.parse(options);
  const channel = parsed.channel ?? CHANNEL;
  const log = createLog(channel);
  const { outputDirectory, compiler, timeout, extraInputDirs } = parsed;
  const latexFile = latexLocation.absolutePath;
  const outDir = outputDirectory ?? path.dirname(latexFile);
  try {
    await AbsoluteFS.ensureDir(outDir);

    // TeX resolves relative `\input{…}` / `\bibliography{…}` against the
    // compiler's cwd and TEXINPUTS, not the main file's location. When a
    // run-storage document (round output or latexdiff) compiles from a build
    // directory, its own folder and any caller-supplied source directories must
    // be on the search path or `\input{preamble}`, `\input{figures/…}`, and the
    // bibliography fail to resolve. The file's own directory comes first so a
    // revised sibling wins over the original source fallback.
    const documentDir = path.dirname(latexFile);

    const tikzInputDirectory = getConfig<string>(
      'texra.latex.tikzInputDirectory',
      '',
    );
    const includeWorkspace = getConfig<boolean>(
      'texra.latex.includeWorkspaceInTexinputs',
      true,
    );
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
    for (const [key, value] of Object.entries(env)) {
      log.debug(`Setting ${key} to: ${value}`);
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

    function runPdflatex() {
      return runToolWithCheck('pdflatex', pdflatexArgs, {
        channel,
        env,
        timeout,
        showError: true, // Show error if pdflatex fails
      });
    }

    let result: ExecResult | false;
    if (compiler === 'latexmk') {
      result = await runToolWithCheck('latexmk', latexmkArgs, {
        channel,
        env,
        timeout,
        showError: false, // Suppress error for latexmk to try pdflatex as fallback
      });
      if (!result) {
        log.warn(
          'latexmk not found, falling back to single-pass pdflatex — ' +
            'bibliography, cross-references, and index may be incomplete',
        );
        result = await runPdflatex();
      }
    } else {
      result = await runPdflatex();
    }

    if (result && result.success) {
      log.debug(`Successfully compiled ${latexFile}`);
      return { ok: true };
    }
    return { ok: false, logTail: await readCompileLogTail(outDir, latexFile) };
  } catch (err) {
    const message = toErrorMessage(err);
    log.error(`Error compiling LaTeX: ${message}`);
    const tail = await readCompileLogTail(outDir, latexFile);
    return {
      ok: false,
      logTail: `Error compiling LaTeX: ${message}\n\n${tail}`,
    };
  }
}
