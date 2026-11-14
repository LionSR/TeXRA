// Node imports
import * as path from 'node:path';
import { hasExtension, pathToLocationIn } from '@texra-ai/harness/host';
import {
  RunFileService,
  type AgentTrace,
  type WorkspaceFs,
} from '@texra-ai/harness/plugins';
import { absentReason } from '@texra-ai/harness/node';

// Third-party imports
import { Effect, FileSystem, Predicate } from 'effect';

// Local imports
import { toErrorMessage, type FileLocation } from '@texra-ai/harness/schemas';
import type { DocumentTaskOptions } from '@texra/shared/plugins/documents';
import { recoverLogged } from '@texra/utils/diagnostics/recoverLogged';

// Local file imports
import { extractLatexFileDependencies } from './extractFileDependencies';
import { extractFigurePathsFromLatex } from './extractFigure';
import { resolveLatexDir } from './latexParsingUtils';
import { compileTikzPictures } from './tikzPictures';
import { compileLatex2Pdf } from './texTools';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** LaTeX project siblings that should always ride alongside the main file. */
const PROJECT_SIBLING_EXTENSIONS = new Set(['.cls', '.sty', '.bst', '.cfg']);
const PROJECT_SIBLING_NAMES = new Set([
  'latexmkrc',
  '.latexmkrc',
  '.latexindentrc',
]);

/** The services a media pass reads, writes and compiles on. */
type MediaServices = FileSystem.FileSystem | WorkspaceFs | ChildProcessSpawner;

/** Maximum concurrent LaTeX compilation operations */
const LATEX_CONCURRENCY = 4;

/** What a media pass reads of the run. */
interface MediaRun {
  readonly logger: AgentTrace;
  /**
   * The session's roots: the settings a PDF or TikZ compile reads, and the
   * workspace every extracted or compiled path is located against.
   */
  readonly roots: WorkspaceRoots;
  readonly fileService: RunFileService;
}

/**
 * Log an item mirroring skipped. A path that is not there (a deleted
 * figure) is expected; any other failure leaves the compile without a file
 * it needs, failing later as a LaTeX "file not found", so it is a warning
 * naming the cause.
 */
function logSkipped(
  logger: AgentTrace,
  message: string,
  path: string,
  error: unknown,
): void {
  (absentReason(error) ? logger.debug : logger.warn).call(logger, message, {
    data: { path, error },
  });
}

/**
 * Mirror each workspace path into run storage at the LaTeX concurrency
 * limit, keeping going when an individual path fails. Mirroring is
 * best-effort by design — a deleted figure or a dependency outside the
 * workspace must not take the surviving files down with it — so a path's
 * typed failure is recovered here and logged with the offending path rather
 * than at each call site. Defects and interruption still propagate: a bug or
 * a cancelled run is not a skipped file.
 */
const forEachFile = <E, R>(
  logger: AgentTrace,
  files: readonly FileLocation[],
  failureMessage: string,
  task: (file: FileLocation) => Effect.Effect<unknown, E, R>,
): Effect.Effect<void, never, R> =>
  Effect.forEach(
    files,
    (file) =>
      task(file).pipe(
        recoverLogged(
          (error) =>
            logSkipped(logger, failureMessage, file.absolutePath, error),
          () => Effect.void,
        ),
      ),
    { concurrency: LATEX_CONCURRENCY, discard: true },
  );

/**
 * Compile one LaTeX file to PDF, returning the PDF's location or `undefined`
 * when the compile fails (which includes writing no PDF, or an empty one).
 */
const compileOnePdf = Effect.fn('latexMedia.compileOnePdf')(function* (
  { logger, roots }: MediaRun,
  file: FileLocation,
): Effect.fn.Return<FileLocation | undefined, Error, MediaServices> {
  const fs = yield* FileSystem.FileSystem;
  // One build directory per input (the shape TikZ compiles use): up to
  // LATEX_CONCURRENCY engines run at once, and two inputs in one folder
  // that share an `\include` or a `.bib` would otherwise write the same
  // `.aux`/`.bbl` files into one `build/` and corrupt each other's.
  const buildDir = path.join(
    path.dirname(file.absolutePath),
    'build',
    path.parse(file.absolutePath).name,
  );
  yield* fs.makeDirectory(buildDir, { recursive: true });
  const compiled = yield* compileLatex2Pdf(file, roots, {
    outputDirectory: buildDir,
  });
  if (!compiled.ok) {
    logger.warn(`Failed to compile LaTeX to PDF:\n${compiled.logTail}`, {
      data: { sourceFile: file.absolutePath, logTail: compiled.logTail },
    });
    return undefined;
  }

  const pdfLocation = pathToLocationIn(roots.workspace, compiled.pdfPath);
  logger.info('Compiled PDF', {
    data: {
      sourceFile: file.absolutePath,
      pdfFile: pdfLocation.absolutePath,
    },
  });
  return pdfLocation;
});

/** Compile the `.tex` files to PDF, returning the PDFs that came out. */
const compilePdfs = Effect.fn('latexMedia.compilePdfs')(function* (
  run: MediaRun,
  texFiles: readonly FileLocation[],
): Effect.fn.Return<FileLocation[], never, MediaServices> {
  const compileResults = yield* Effect.forEach(
    texFiles,
    (file) =>
      // The build-directory and existence-probe I/O (and path resolution)
      // fail here; a compile that merely returns { ok: false } is logged
      // inside compileOnePdf. Either way the remaining files continue.
      compileOnePdf(run, file).pipe(
        recoverLogged(
          (error) =>
            run.logger.warn(
              `Skipping PDF compile for ${file.absolutePath}: ${toErrorMessage(error)}`,
              { data: { sourceFile: file.absolutePath, error } },
            ),
          () => Effect.succeed(undefined),
        ),
      ),
    { concurrency: LATEX_CONCURRENCY },
  );

  return compileResults.filter(Predicate.isNotNullish);
});

/**
 * Shallow scan of a LaTeX project directory for common sibling files
 * (*.cls, *.sty, *.bst, latexmkrc, .latexindentrc) and mirror them into
 * run storage so the compiled document can find its project-local style.
 */
const mirrorProjectSiblings = Effect.fn('latexMedia.mirrorProjectSiblings')(
  function* (
    { logger, roots, fileService }: MediaRun,
    projectDir: string,
  ): Effect.fn.Return<void, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(projectDir).pipe(
      recoverLogged(
        (error) =>
          logSkipped(
            logger,
            'Unable to scan project siblings',
            projectDir,
            error,
          ),
        () => Effect.succeed(undefined),
      ),
    );
    if (!entries) return;

    const candidates = entries
      .filter(
        (name) =>
          PROJECT_SIBLING_EXTENSIONS.has(path.extname(name).toLowerCase()) ||
          PROJECT_SIBLING_NAMES.has(name),
      )
      .map((name) =>
        pathToLocationIn(roots.workspace, path.join(projectDir, name)),
      );

    yield* forEachFile(
      logger,
      candidates,
      'Unable to mirror project sibling',
      Effect.fnUntraced(function* (candidate) {
        const stats = yield* fs.stat(candidate.absolutePath);
        if (stats.type !== 'File') return;
        yield* fileService.mirrorWorkspaceFile(candidate);
      }),
    );
  },
);

/**
 * Mirror \input, \include, \bibliography, \usepackage targets, and common
 * project-sibling files (.cls/.sty/.bst/latexmkrc/.latexindentrc) into run
 * storage so output files can be compiled outside the workspace.
 *
 * Dep discovery is recursive: each newly mirrored .tex is re-parsed so
 * that transitive includes (e.g. main.tex → chapters/ch1.tex →
 * chapters/figures/fig1.tex) are all brought along.
 */
const mirrorLatexFileDependencies = Effect.fn(
  'latexMedia.mirrorLatexFileDependencies',
)(function* (
  run: MediaRun,
  texFiles: readonly FileLocation[],
): Effect.fn.Return<void, never, FileSystem.FileSystem> {
  const { logger, roots, fileService } = run;
  const visited = new Set<string>();
  const worklist: FileLocation[] = [...texFiles];

  // Sweep siblings of every root input file up front. `resolveLatexDir`
  // follows the symlink first, so a mirrored .tex inside run storage
  // points back at the original workspace tree — otherwise project-local
  // .cls/.sty/.bst/latexmkrc files that live beside the real source are
  // invisible — and falls back to the literal dirname when it can't.
  yield* Effect.forEach(
    texFiles,
    (file) =>
      resolveLatexDir(file.absolutePath).pipe(
        Effect.flatMap((siblingDir) => mirrorProjectSiblings(run, siblingDir)),
      ),
    { concurrency: LATEX_CONCURRENCY, discard: true },
  );

  for (
    let file = worklist.shift();
    file !== undefined;
    file = worklist.shift()
  ) {
    if (visited.has(file.absolutePath)) continue;
    visited.add(file.absolutePath);

    const deps = yield* extractLatexFileDependencies(file).pipe(
      recoverLogged(
        (error) =>
          logSkipped(
            logger,
            'Unable to extract LaTeX dependencies',
            file.absolutePath,
            error,
          ),
        () => Effect.succeed<readonly string[]>([]),
      ),
    );
    if (deps.length === 0) continue;

    yield* forEachFile(
      logger,
      deps.map((dep) => pathToLocationIn(roots.workspace, dep)),
      'Unable to mirror LaTeX dependency',
      Effect.fnUntraced(function* (depLocation) {
        const isTex = hasExtension(depLocation.absolutePath, '.tex');
        yield* fileService.mirrorWorkspaceFile(depLocation, {
          snapshot: isTex,
        });
        if (isTex) {
          worklist.push(depLocation);
        }
      }),
    );
    logger.debug('Mirrored LaTeX dependencies', {
      data: { count: deps.length, from: file.absolutePath },
    });
  }
});

/**
 * The existing figures the files include, as media, each also mirrored
 * into run storage.
 */
const extractFiguresFromFiles = Effect.fn('latexMedia.extractFiguresFromFiles')(
  function* (
    { logger, roots, fileService }: MediaRun,
    files: readonly FileLocation[],
  ): Effect.fn.Return<FileLocation[], Error, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    // Each file's extraction, base directory and existence probes run
    // together; the results come back in file order for the logs below.
    const figureResults = yield* Effect.forEach(
      files,
      (file) =>
        extractFigurePathsFromLatex(file).pipe(
          // A malformed or unreadable .tex file contributes no figures
          // rather than aborting the surrounding fan-out, but the document
          // then compiles without them, so the cause is named.
          recoverLogged(
            (error) =>
              logger.warn('Unable to extract figure paths', {
                data: { path: file.absolutePath, error },
              }),
            () => Effect.succeed<readonly string[]>([]),
          ),
          Effect.flatMap(
            Effect.fnUntraced(function* (figures) {
              if (figures.length === 0) return { file, figures, probed: [] };
              // Match the resolution in extractFigurePathsFromLatex so the
              // returned figure paths (relative to the real latexDir) map
              // back to workspace files when the .tex is symlinked into run
              // storage (otherwise mirrorWorkspaceFile would classify them
              // as external and skip).
              const baseDir = yield* resolveLatexDir(file.absolutePath);
              // A figure that no longer exists cannot be compiled into the
              // PDF or attached to vision context, so it must not enter
              // media.
              const probed = yield* Effect.forEach(
                figures,
                (relativePath) => {
                  const loc = pathToLocationIn(
                    roots.workspace,
                    path.normalize(path.join(baseDir, relativePath)),
                  );
                  return fs
                    .exists(loc.absolutePath)
                    .pipe(Effect.map((exists) => ({ loc, exists })));
                },
                { concurrency: LATEX_CONCURRENCY },
              );
              return { file, figures, probed };
            }),
          ),
        ),
      { concurrency: LATEX_CONCURRENCY },
    );

    const media: FileLocation[] = [];
    for (const { file, figures, probed } of figureResults) {
      if (figures.length === 0) continue;
      logger.debug('Extracted figures', {
        data: { count: figures.length, from: file.absolutePath },
      });
      for (const { loc, exists } of probed) {
        if (exists) {
          media.push(loc);
          continue;
        }
        logger.debug('Extracted figure path does not exist', {
          data: { figurePath: loc.absolutePath, from: file.absolutePath },
        });
      }
    }

    // Every figure a file names is mirrored, found or not, from the
    // locations probed above.
    const figureLocations = new Map(
      figureResults.flatMap(({ probed }) =>
        probed.map(({ loc }) => [loc.absolutePath, loc] as const),
      ),
    );
    yield* forEachFile(
      logger,
      [...figureLocations.values()],
      'Unable to mirror figure dependency',
      (loc) => fileService.mirrorWorkspaceFile(loc),
    );
    return media;
  },
);

const compileTikzFigures = Effect.fn('latexMedia.compileTikzFigures')(
  function* (
    { logger, roots }: MediaRun,
    files: readonly FileLocation[],
  ): Effect.fn.Return<FileLocation[], never, MediaServices> {
    const tikzResults = yield* Effect.forEach(
      files,
      (file) =>
        compileTikzPictures(file, roots).pipe(
          // The fan-out continues past an individual failure. A failed
          // compile is reported by compileTikzPictures itself; everything
          // else (standalone generation, the filesystem) lands here and
          // would otherwise vanish.
          recoverLogged(
            (error) =>
              logger.warn('TikZ extraction failed', {
                data: { path: file.absolutePath, error },
              }),
            () => Effect.succeed<FileLocation[]>([]),
          ),
        ),
      { concurrency: LATEX_CONCURRENCY },
    );

    const compiledFigures = tikzResults.flat();
    logger.debug(`Extracted ${compiledFigures.length} TikZ figures`);
    return compiledFigures;
  },
);

/**
 * The media of the input files the task's options ask for: their existing
 * figures, compiled TikZ pictures and compiled PDFs, in that order. Their
 * LaTeX dependencies are mirrored into run storage either way. None when no
 * input file exists.
 */
export const processInputFiles = Effect.fn('latexMedia.processInputFiles')(
  function* (
    run: MediaRun,
    inputFiles: readonly FileLocation[],
    cfg: DocumentTaskOptions,
  ): Effect.fn.Return<FileLocation[], Error, MediaServices> {
    const fs = yield* FileSystem.FileSystem;
    const probed = yield* Effect.forEach(
      inputFiles,
      (file) =>
        fs
          .exists(file.absolutePath)
          .pipe(Effect.map((exists) => ({ file, exists }))),
      { concurrency: LATEX_CONCURRENCY },
    );
    const existingFiles = probed
      .filter((entry) => entry.exists)
      .map((entry) => entry.file);
    if (existingFiles.length === 0) return [];
    const texFiles = existingFiles.filter((file) =>
      hasExtension(file.absolutePath, '.tex'),
    );

    const media: FileLocation[] = [];
    if (cfg.autoExtractFigure) {
      media.push(...(yield* extractFiguresFromFiles(run, existingFiles)));
    }

    yield* mirrorLatexFileDependencies(run, texFiles);

    if (cfg.autoExtractTikzFigure) {
      media.push(...(yield* compileTikzFigures(run, existingFiles)));
    }

    if (cfg.autoCompileInputPdf) {
      media.push(...(yield* compilePdfs(run, texFiles)));
    }
    return media;
  },
);
