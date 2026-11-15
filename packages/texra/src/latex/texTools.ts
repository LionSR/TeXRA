// Node imports
import * as path from 'node:path';

// External imports
import { Config, Effect, FileSystem, Option, Schema } from 'effect';

// Local imports
import { WorkspaceFs, Settings } from '@texra-ai/harness/plugins';
import { absentReason } from '@texra-ai/harness/node';
import {
  toErrorMessage,
  splitContentLines,
  type FileLocation,
} from '@texra-ai/harness/schemas';
import { SUPPORTED_LATEX_COMPILERS } from '@texra/shared/constants/latexToolchain';
import { runTool, type ToolMissing } from '@texra/utils/system/toolChecks';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import {
  INCLUDE_WORKSPACE_IN_TEXINPUTS_SETTING,
  TIKZ_INPUT_DIRECTORY_SETTING,
} from '@texra/shared/settings/texraSettings';

// Raw tail, no TeX-log parsing -- a deliberate choice (see compileCheck.ts):
// tex compile logs are noisy and heuristic parsing is a losing game, so every
// caller gets the same last-N-lines excerpt an LLM or a human can read as-is.
const LOG_TAIL_LINES = 200;

/** Options for {@link compileLatex2Pdf}; every caller is TypeScript, so the
 *  type is the check. */
interface LaTeXCompileOptions {
  readonly outputDirectory?: string;
  /** The engine to drive: latexmk unless named. */
  readonly compiler?: (typeof SUPPORTED_LATEX_COMPILERS)[number];
  /** Millisecond timeout per compiler invocation. Kills the child on expiry. */
  readonly timeout?: number;
  /**
   * Extra directories to prepend onto the kpathsea search path (TEXINPUTS /
   * BIBINPUTS / BSTINPUTS), after the main file's own directory and before the
   * workspace root. Used when a run-storage document compiles outside its
   * original location so relative `\input{…}` / `\bibliography{…}` targets
   * (e.g. `figures/fig.tex`, `library.bib`) still resolve against the original
   * source directory.
   */
  readonly extraInputDirs?: readonly string[];
}

/**
 * Read the tail of the `.log` file a LaTeX engine drops next to its output.
 * Shared by every {@link compileLatex2Pdf} caller so a failed compile always
 * comes with enough context to act on, not just a boolean.
 */
const readCompileLogTail = Effect.fn('texTools.readCompileLogTail')(function* (
  logAbs: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(logAbs).pipe(
    Effect.map((full) =>
      splitContentLines(full).slice(-LOG_TAIL_LINES).join('\n'),
    ),
    Effect.catchTag('PlatformError', (error) =>
      Effect.succeed(`(no LaTeX log at ${logAbs}: ${error.message})`),
    ),
  );
});

/** The compiler could not be run at all, as opposed to running and failing. */
class LatexCompilerNotRun extends Schema.TaggedError<LatexCompilerNotRun>()(
  'LatexCompilerNotRun',
  {
    cause: Schema.Defect(),
  },
) {}

// `path.delimiter` throughout, so the joined value is ':'-separated on POSIX
// and ';'-separated on Windows, which is what kpathsea parses on each.
function buildKpathseaSearchPath(
  prependPaths: readonly string[],
  existingValue: string | undefined,
): string | undefined {
  const D = path.delimiter;
  const prefix = prependPaths
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(D);
  if (!prefix) return undefined;

  const value = existingValue ? `${prefix}${D}${existingValue}` : prefix;
  return value.endsWith(D) ? value : `${value}${D}`;
}

/**
 * Build the kpathsea search-path overrides (TEXINPUTS / BIBINPUTS / BSTINPUTS)
 * for a LaTeX compile, prepending the workspace and TikZ input directories onto
 * any inherited values.
 *
 * The three inherited values come from the ambient Effect `ConfigProvider`
 * (the live process environment in production). The subprocess still inherits
 * the rest of `process.env` via `executeCommand`'s `commandEnv`, so these keys
 * only override the three search paths that need prepending.
 */
const latexInputEnv = Effect.fn('texTools.latexInputEnv')(function* (
  texInputParts: readonly string[],
  bibSearchParts: readonly string[],
): Effect.fn.Return<Record<string, string>> {
  const [tex, bib, bst] = (yield* Effect.all([
    Config.String('TEXINPUTS').pipe(Config.option, Effect.orDie),
    Config.String('BIBINPUTS').pipe(Config.option, Effect.orDie),
    Config.String('BSTINPUTS').pipe(Config.option, Effect.orDie),
  ])).map(Option.getOrUndefined);
  const texInputs = buildKpathseaSearchPath(texInputParts, tex);
  const bibInputs = buildKpathseaSearchPath(bibSearchParts, bib);
  const bstInputs = buildKpathseaSearchPath(bibSearchParts, bst);
  return {
    ...(texInputs && { TEXINPUTS: texInputs }),
    ...(bibInputs && { BIBINPUTS: bibInputs }),
    ...(bstInputs && { BSTINPUTS: bstInputs }),
  };
});

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
function buildLatexSearchParts(input: {
  documentDir: string;
  extraInputDirs?: readonly string[];
  workspaceRoot?: string | null;
  tikzInputDirectory?: string | null;
}): { texInputParts: string[]; bibSearchParts: string[] } {
  const { documentDir, extraInputDirs, workspaceRoot, tikzInputDirectory } =
    input;
  const sourceDirs = [documentDir, ...(extraInputDirs ?? [])];
  const workspaceParts = workspaceRoot ? [workspaceRoot] : [];
  const tikzParts = tikzInputDirectory?.trim() ? [tikzInputDirectory] : [];
  return {
    texInputParts: [...sourceDirs, '.', ...workspaceParts, ...tikzParts],
    bibSearchParts: [...sourceDirs, ...workspaceParts],
  };
}

/**
 * Result of a {@link compileLatex2Pdf} attempt. A discriminated union on `ok`
 * so the type system guarantees {@link LOG_TAIL_LINES}'s worth of the
 * engine's `.log` file tail is present whenever compilation fails, and the
 * path of a non-empty PDF where the engine writes whenever it succeeds —
 * instead of every caller re-deriving that path, or checking the file, its
 * own way. The file is not proven to be this run's: an earlier build's PDF
 * in a reused output directory also reads as success.
 */
type CompileLatex2PdfResult =
  | { ok: true; pdfPath: string }
  | { ok: false; logTail: string };

/**
 * Compile a LaTeX file to PDF.
 *
 * The compiler runs in the session's workspace root and, when
 * `texra.latex.includeWorkspaceInTexinputs` is on, searches it: the root is
 * the {@link WorkspaceFs} in context, and the two LaTeX settings come from
 * `roots`, that same session's setting slots held as data, so a compile
 * never reads whichever roots the calling fiber happens to carry. The build
 * directory and the engine log are absolute paths (run storage, a build
 * folder, an external file) and go through the process `FileSystem`.
 *
 * @param latexLocation FileLocation for the LaTeX file
 * @param roots The session's setting slots
 * @param options Compilation options; its lines take the caller's log channel
 * @returns `{ ok: true, pdfPath } | { ok: false, logTail }` -- `pdfPath` is the
 * absolute path of a non-empty PDF where the engine writes (an earlier
 * build's in a reused output directory counts); `logTail` is always
 * populated on failure, including an exit 0 that left no PDF.
 * Fails with `ToolMissing` when no engine it drives is installed: a missing
 * latexmk falls back to pdflatex, and a missing pdflatex is that failure.
 */
export const compileLatex2Pdf = Effect.fn('compileLatex2Pdf')(function* (
  latexLocation: FileLocation,
  roots: WorkspaceRoots,
  options: LaTeXCompileOptions = {},
): Effect.fn.Return<
  CompileLatex2PdfResult,
  ToolMissing,
  FileSystem.FileSystem | WorkspaceFs | ChildProcessSpawner
> {
  const {
    outputDirectory,
    compiler = 'latexmk',
    timeout,
    extraInputDirs = [],
  } = options;
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = (yield* WorkspaceFs).root;
  const latexFile = latexLocation.absolutePath;
  const outDir = outputDirectory ?? path.dirname(latexFile);
  // Both engine outputs are named after the source with the source's own
  // extension removed (.tex/.ltx/.latex are all compilable, per isLatexFile),
  // so one stem owns both the `.log` we read back and the `.pdf` we report.
  const outputStem = path.join(
    outDir,
    path.basename(latexFile, path.extname(latexFile)),
  );

  const compile = Effect.gen(function* () {
    yield* fs.makeDirectory(outDir, { recursive: true });

    // TeX resolves relative `\input{…}` / `\bibliography{…}` against the
    // compiler's cwd and TEXINPUTS, not the main file's location. When a
    // run-storage document (round output or latexdiff) compiles from a build
    // directory, its own folder and any caller-supplied source directories must
    // be on the search path or `\input{preamble}`, `\input{figures/…}`, and the
    // bibliography fail to resolve. The file's own directory comes first so a
    // revised sibling wins over the original source fallback.
    const documentDir = path.dirname(latexFile);

    const tikzInputDirectory = yield* Settings.get(
      roots,
      TIKZ_INPUT_DIRECTORY_SETTING,
    );
    const includeWorkspace = yield* Settings.get(
      roots,
      INCLUDE_WORKSPACE_IN_TEXINPUTS_SETTING,
    );
    const { texInputParts, bibSearchParts } = buildLatexSearchParts({
      documentDir,
      extraInputDirs,
      workspaceRoot: includeWorkspace ? workspaceRoot : null,
      tikzInputDirectory,
    });

    // Build kpathsea search-path overrides, prepending workspace/TikZ dirs onto
    // any inherited values. `path.delimiter` keeps it cross-platform.
    const env = yield* latexInputEnv(texInputParts, bibSearchParts);
    for (const [key, value] of Object.entries(env)) {
      yield* Effect.logDebug(`Setting ${key} to: ${value}`);
    }

    // The compiler's cwd is the workspace root: a session with no folder open
    // has nowhere to run it.
    if (workspaceRoot === undefined) {
      return yield* new LatexCompilerNotRun({
        cause: new Error('No workspace path found'),
      });
    }

    const pdflatexArgs = [
      '-interaction=nonstopmode',
      `-output-directory=${outDir}`,
      latexFile,
    ];

    const latexmkArgs = ['-pdf', '-f', ...pdflatexArgs];

    // Interrupting the compile stops the engine: the fiber's interruption is
    // what aborts the spawn, so nothing threads a signal through. latexmk
    // hands each pass to a pdflatex/bibtex/biber child, so its stop (and
    // timeout) signals the whole tree: a tracked-pid kill would stop latexmk
    // and leave its engine writing into the build directory. A lone pdflatex
    // has no children to reach, and the tree kill's detached spawn would move
    // it out of our process group, where a hard host kill no longer reaches
    // it, so it keeps the single-process form.
    const runEngine = (tool: 'latexmk' | 'pdflatex', args: string[]) =>
      runTool(tool, args, {
        cwd: workspaceRoot,
        env,
        timeout,
        killProcessTree: tool === 'latexmk',
      });
    const pdflatex = runEngine('pdflatex', pdflatexArgs);

    // A missing latexmk falls back to pdflatex; a missing pdflatex is the
    // caller's `ToolMissing`.
    const result =
      compiler === 'latexmk'
        ? yield* runEngine('latexmk', latexmkArgs).pipe(
            Effect.catchTag('ToolMissing', () =>
              Effect.logWarning(
                'latexmk not found, falling back to single-pass pdflatex: ' +
                  'bibliography, cross-references, and index may be incomplete',
              ).pipe(Effect.andThen(pdflatex)),
            ),
          )
        : yield* pdflatex;

    if (result.success) {
      // The exit code is not the PDF: a document with no pages exits 0 and
      // writes none, so success is a non-empty file where the engine writes.
      const pdfPath = `${outputStem}.pdf`;
      const written = yield* fs
        .stat(pdfPath)
        .pipe(Effect.catchIf(absentReason, () => Effect.succeed(undefined)));
      if (written?.type === 'File' && Number(written.size) > 0) {
        yield* Effect.logDebug(`Successfully compiled ${latexFile}`);
        return { ok: true, pdfPath } as const;
      }
      return {
        ok: false,
        logTail: `The LaTeX engine finished but wrote no PDF at ${pdfPath}.\n\n${yield* readCompileLogTail(`${outputStem}.log`)}`,
      } as const;
    }
    return {
      ok: false,
      logTail: yield* readCompileLogTail(`${outputStem}.log`),
    } as const;
  });

  const failed = Effect.fnUntraced(function* (message: string) {
    yield* Effect.logError(`Error compiling LaTeX: ${message}`);
    const tail = yield* readCompileLogTail(`${outputStem}.log`);
    return {
      ok: false,
      logTail: `Error compiling LaTeX: ${message}\n\n${tail}`,
    } as const;
  });

  return yield* compile.pipe(
    Effect.catchTags({
      PlatformError: (error) => failed(error.message),
      StateReadFailed: (error) => failed(error.message),
      LatexCompilerNotRun: (error) => failed(toErrorMessage(error.cause)),
    }),
  );
});
