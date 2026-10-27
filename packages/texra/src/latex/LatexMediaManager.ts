// Node imports
import * as path from 'node:path';
import { hasExtension, pathToLocationIn } from '@texra-ai/harness';
import { RunFileService } from '@texra-ai/harness/plugins';
import { absentReason } from '@texra-ai/harness/node';

// Third-party imports
import { Effect, FileSystem, PlatformError, Predicate } from 'effect';

// Local imports
import { toErrorMessage, type FileLocation } from '@texra-ai/harness/schemas';
import type { DocumentTaskOptions } from '@texra/shared/plugins/documents';

// Local file imports
import { extractLatexFileDependencies } from './extractFileDependencies';
import { extractFigurePathsFromLatex } from './extractFigure';
import { resolveLatexDir } from './latexParsingUtils';
import { TikzPictureManager } from './TikzPictureManager';
import { compileLatex2Pdf } from './texTools';
import type { WorkspaceFs, WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** LaTeX project siblings that should always ride alongside the main file. */
const PROJECT_SIBLING_EXTENSIONS = new Set(['.cls', '.sty', '.bst', '.cfg']);

/** The services a media pass reads, writes and compiles on. */
type MediaServices = FileSystem.FileSystem | WorkspaceFs | ChildProcessSpawner;
const PROJECT_SIBLING_NAMES = new Set([
  'latexmkrc',
  '.latexmkrc',
  '.latexindentrc',
]);

/** Maximum concurrent LaTeX compilation operations */
const LATEX_CONCURRENCY = 4;

/** Options accepted by the logging slice of {@link LatexTrace}. */
interface LatexLogOptions {
  readonly data?: unknown;
}

/**
 * The logging slice `LatexMediaManager` actually calls. Structurally
 * satisfied by `AgentTrace`; declared here so LaTeX processing stays
 * independent of agent execution internals.
 */
export interface LatexTrace {
  debug(message: string, options?: LatexLogOptions): void;
  info(message: string, options?: LatexLogOptions): void;
  warn(message: string, options?: LatexLogOptions): void;
  error(message: string, options?: LatexLogOptions): void;
}

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  private readonly logger: LatexTrace;
  private readonly roots: WorkspaceRoots;
  private readonly fileService: RunFileService;
  constructor(
    logger: LatexTrace,
    /**
     * The session's roots: the settings a PDF or TikZ compile reads, and the
     * workspace every extracted or compiled path is located against.
     */
    roots: WorkspaceRoots,
    fileService: RunFileService,
  ) {
    this.logger = logger;
    this.roots = roots;
    this.fileService = fileService;
  }

  /**
   * Run `task` over `items` at the LaTeX concurrency limit, keeping going when
   * an individual item fails. Mirroring is best-effort by design — a deleted
   * figure or a dependency outside the workspace must not take the surviving
   * files down with it — so an item's typed failure is recovered here and
   * logged with the offending path rather than at each call site. Defects and
   * interruption still propagate: a bug or a cancelled run is not a skipped
   * file.
   */
  private forEachFile<T, E, R>(
    items: readonly T[],
    pathOf: (item: T) => string,
    failureMessage: string,
    task: (item: T) => Effect.Effect<unknown, E, R>,
  ): Effect.Effect<void, never, R> {
    return Effect.forEach(
      items,
      (item) =>
        task(item).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              this.logSkipped(failureMessage, pathOf(item), error),
            ),
          ),
        ),
      { concurrency: LATEX_CONCURRENCY, discard: true },
    );
  }

  /**
   * Log an item mirroring skipped. A path that is not there (a deleted
   * figure) is expected; any other failure leaves the compile without a file
   * it needs, failing later as a LaTeX "file not found", so it is a warning
   * naming the cause.
   */
  private logSkipped(message: string, path: string, error: unknown): void {
    const absent = PlatformError.isPlatformError(error) && absentReason(error);
    (absent ? this.logger.debug : this.logger.warn).call(this.logger, message, {
      data: { path, error },
    });
  }

  private mirrorFigureDependencies(
    latexFile: FileLocation,
    figures: readonly string[],
    baseDir?: string,
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (figures.length === 0) {
        return;
      }

      // Resolve against the workspace directory so figure paths from a
      // run-storage symlink map back to real workspace files (otherwise
      // mirrorWorkspaceFile would classify them as external and skip).
      // Callers that already resolved this for their own purposes (e.g.
      // extractFiguresFromFiles) pass it in to avoid a redundant lookup.
      const resolvedBaseDir =
        baseDir ?? (yield* resolveLatexDir(latexFile.absolutePath));
      const absolutePaths = new Set(
        figures
          .map((relative) => relative.trim())
          .filter((trimmed) => trimmed !== '')
          .map((trimmed) =>
            path.normalize(path.join(resolvedBaseDir, trimmed)),
          ),
      );

      if (absolutePaths.size === 0) {
        return;
      }

      yield* this.forEachFile(
        [...absolutePaths],
        (absolutePath) => absolutePath,
        'Unable to mirror figure dependency',
        (absolutePath) =>
          this.fileService.mirrorWorkspaceFile(
            pathToLocationIn(this.roots.workspace, absolutePath),
          ),
      );
    });
  }

  /**
   * Compile one LaTeX file to PDF, returning the PDF's location or `undefined`
   * when the compile, the write, or the size check disqualifies it.
   */
  private compileOnePdf(
    file: FileLocation,
  ): Effect.Effect<FileLocation | undefined, Error, MediaServices> {
    return Effect.gen({ self: this }, function* () {
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
      const compiled = yield* compileLatex2Pdf(file, this.roots, {
        outputDirectory: buildDir,
      });
      if (!compiled.ok) {
        this.logger.warn(
          `Failed to compile LaTeX to PDF:\n${compiled.logTail}`,
          {
            data: { sourceFile: file.absolutePath, logTail: compiled.logTail },
          },
        );
        return undefined;
      }

      const pdfLocation = pathToLocationIn(
        this.roots.workspace,
        compiled.pdfPath,
      );
      const written = yield* fs.exists(pdfLocation.absolutePath);
      if (!written) {
        this.logger.warn(
          'LaTeX reported success but no PDF was written; skipping',
          {
            data: {
              sourceFile: file.absolutePath,
              pdfFile: pdfLocation.absolutePath,
            },
          },
        );
        return undefined;
      }

      // Stat failures are noisier than other compile failures because an
      // existing-but-unreadable PDF likely indicates a permissions/IO bug.
      const stats = yield* fs.stat(pdfLocation.absolutePath).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            this.logger.error(
              `Failed to stat compiled PDF ${pdfLocation.absolutePath}: ${toErrorMessage(err)}`,
              { data: { path: pdfLocation.absolutePath, error: err } },
            );
            return undefined;
          }),
        ),
      );
      if (!stats) return undefined;
      if (Number(stats.size) === 0) {
        this.logger.warn('Compiled PDF is empty', {
          data: {
            sourceFile: file.absolutePath,
            pdfFile: pdfLocation.absolutePath,
          },
        });
        return undefined;
      }

      this.logger.info('Compiled PDF', {
        data: {
          sourceFile: file.absolutePath,
          pdfFile: pdfLocation.absolutePath,
        },
      });
      return pdfLocation;
    });
  }

  /** Compile LaTeX files to PDF, returning the PDFs that came out. */
  private compilePdfs(
    files: readonly FileLocation[],
  ): Effect.Effect<FileLocation[], never, MediaServices> {
    return Effect.gen({ self: this }, function* () {
      const texFiles = files.filter((file) =>
        hasExtension(file.absolutePath, '.tex'),
      );

      const compileResults = yield* Effect.forEach(
        texFiles,
        (file) =>
          // The build-directory and existence-probe I/O (and path resolution)
          // fail here; a compile that merely returns { ok: false } is logged
          // inside compileOnePdf. Either way the remaining files continue.
          this.compileOnePdf(file).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                this.logger.warn(
                  `Skipping PDF compile for ${file.absolutePath}: ${toErrorMessage(error)}`,
                  { data: { sourceFile: file.absolutePath, error } },
                );
                return undefined;
              }),
            ),
          ),
        { concurrency: LATEX_CONCURRENCY },
      );

      return compileResults.filter(Predicate.isNotNullish);
    });
  }

  /**
   * Mirror \input, \include, \bibliography, \usepackage targets, and common
   * project-sibling files (.cls/.sty/.bst/latexmkrc/.latexindentrc) into run
   * storage so output files can be compiled outside the workspace.
   *
   * Dep discovery is recursive: each newly mirrored .tex is re-parsed so
   * that transitive includes (e.g. main.tex → chapters/ch1.tex →
   * chapters/figures/fig1.tex) are all brought along.
   */
  private mirrorLatexFileDependencies(
    files: readonly FileLocation[],
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      const fileService = this.fileService;
      const texFiles = files.filter((file) =>
        hasExtension(file.absolutePath, '.tex'),
      );
      if (texFiles.length === 0) return;

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
            Effect.flatMap((siblingDir) =>
              this.mirrorProjectSiblings(siblingDir),
            ),
          ),
        { concurrency: LATEX_CONCURRENCY, discard: true },
      );

      while (worklist.length > 0) {
        const file = worklist.shift()!;
        if (visited.has(file.absolutePath)) continue;
        visited.add(file.absolutePath);

        const deps = yield* extractLatexFileDependencies(file).pipe(
          Effect.catch((error) =>
            Effect.sync((): readonly string[] => {
              this.logSkipped(
                'Unable to extract LaTeX dependencies',
                file.absolutePath,
                error,
              );
              return [];
            }),
          ),
        );
        if (deps.length === 0) continue;

        const workspaceRoot = this.roots.workspace;
        yield* this.forEachFile(
          deps,
          (absolutePath) => absolutePath,
          'Unable to mirror LaTeX dependency',
          (absolutePath) =>
            Effect.gen(function* () {
              const depLocation = pathToLocationIn(workspaceRoot, absolutePath);
              const isTex = hasExtension(absolutePath, '.tex');
              yield* fileService.mirrorWorkspaceFile(depLocation, {
                snapshot: isTex,
              });
              if (isTex) {
                worklist.push(depLocation);
              }
            }),
        );
        this.logger.debug('Mirrored LaTeX dependencies', {
          data: { count: deps.length, from: file.absolutePath },
        });
      }
    });
  }

  /**
   * Shallow scan of a LaTeX project directory for common sibling files
   * (*.cls, *.sty, *.bst, latexmkrc, .latexindentrc) and mirror them into
   * run storage so the compiled document can find its project-local style.
   */
  private mirrorProjectSiblings(
    projectDir: string,
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      const fileService = this.fileService;
      const fs = yield* FileSystem.FileSystem;
      const entries = yield* fs.readDirectory(projectDir).pipe(
        Effect.catch((error) =>
          Effect.sync((): readonly string[] | undefined => {
            this.logSkipped(
              'Unable to scan project siblings',
              projectDir,
              error,
            );
            return undefined;
          }),
        ),
      );
      if (!entries) return;

      const candidates = entries
        .filter(
          (name) =>
            PROJECT_SIBLING_EXTENSIONS.has(path.extname(name).toLowerCase()) ||
            PROJECT_SIBLING_NAMES.has(name),
        )
        .map((name) => path.join(projectDir, name));

      if (candidates.length === 0) return;

      const workspaceRoot = this.roots.workspace;
      yield* this.forEachFile(
        candidates,
        (absolutePath) => absolutePath,
        'Unable to mirror project sibling',
        (absolutePath) =>
          Effect.gen(function* () {
            const stats = yield* fs.stat(absolutePath);
            if (stats.type !== 'File') return;
            yield* fileService.mirrorWorkspaceFile(
              pathToLocationIn(workspaceRoot, absolutePath),
            );
          }),
      );
    });
  }

  /**
   * The existing figures the files include, as media, each also mirrored
   * into run storage.
   */
  private extractFiguresFromFiles(
    files: readonly FileLocation[],
  ): Effect.Effect<FileLocation[], Error, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = this.roots.workspace;
      // Each file's extraction, base directory and existence probes run
      // together; the results come back in file order for the logs below.
      const figureResults = yield* Effect.forEach(
        files,
        (file) =>
          extractFigurePathsFromLatex(file).pipe(
            // A malformed or unreadable .tex file contributes no figures
            // rather than aborting the surrounding fan-out, but the document
            // then compiles without them, so the cause is named.
            Effect.catch((error) =>
              Effect.sync((): readonly string[] => {
                this.logger.warn('Unable to extract figure paths', {
                  data: { path: file.absolutePath, error },
                });
                return [];
              }),
            ),
            Effect.flatMap((figures) =>
              Effect.gen(function* () {
                if (figures.length === 0)
                  return { file, figures, baseDir: '', probed: [] };
                // Match the resolution in extractFigurePathsFromLatex so the
                // returned figure paths (relative to the real latexDir) map
                // back to workspace files when the .tex is symlinked into run
                // storage.
                const baseDir = yield* resolveLatexDir(file.absolutePath);
                // A figure that no longer exists cannot be compiled into the
                // PDF or attached to vision context, so it must not enter
                // media. The resolution above re-derives baseDir (unlike
                // extractFigurePathsFromLatex, whose paths were checked
                // against the original latexDir), so this filter is a real
                // gate, not a re-check of already-known data.
                const probed = yield* Effect.forEach(
                  figures,
                  (relativePath) => {
                    const loc = pathToLocationIn(
                      workspace,
                      path.normalize(path.join(baseDir, relativePath)),
                    );
                    return fs
                      .exists(loc.absolutePath)
                      .pipe(Effect.map((exists) => ({ loc, exists })));
                  },
                  { concurrency: LATEX_CONCURRENCY },
                );
                return { file, figures, baseDir, probed };
              }),
            ),
          ),
        { concurrency: LATEX_CONCURRENCY },
      );

      const media: FileLocation[] = [];
      const mirrors: Effect.Effect<void, never, FileSystem.FileSystem>[] = [];

      for (const { file, figures, baseDir, probed } of figureResults) {
        if (figures.length === 0) {
          continue;
        }

        this.logger.debug('Extracted figures', {
          data: { count: figures.length, from: file.absolutePath },
        });

        const existingLocations: FileLocation[] = [];
        for (const { loc, exists } of probed) {
          if (!exists) {
            this.logger.debug('Extracted figure path does not exist', {
              data: { figurePath: loc.absolutePath, from: file.absolutePath },
            });
            continue;
          }
          existingLocations.push(loc);
        }

        media.push(...existingLocations);
        mirrors.push(this.mirrorFigureDependencies(file, figures, baseDir));
      }

      yield* Effect.all(mirrors, {
        concurrency: LATEX_CONCURRENCY,
        discard: true,
      });
      return media;
    });
  }

  private compileTikzFigures(
    files: readonly FileLocation[],
  ): Effect.Effect<FileLocation[], never, MediaServices> {
    return Effect.gen({ self: this }, function* () {
      const tikzResults = yield* Effect.forEach(
        files,
        (file) =>
          TikzPictureManager.compile(file, this.roots).pipe(
            // The fan-out continues past an individual failure. A failed
            // compile is reported by TikzPictureManager itself; everything
            // else (standalone generation, the filesystem) lands here and
            // would otherwise vanish.
            Effect.catch((error) =>
              Effect.sync((): FileLocation[] => {
                this.logger.warn('TikZ extraction failed', {
                  data: { path: file.absolutePath, error },
                });
                return [];
              }),
            ),
          ),
        { concurrency: LATEX_CONCURRENCY },
      );

      const compiledFigures = tikzResults.flat();
      this.logger.debug(`Extracted ${compiledFigures.length} TikZ figures`);
      return compiledFigures;
    });
  }

  /**
   * Process input files to extract figures, compile TikZ pictures and PDFs,
   * returning the resulting media: `extraMediaFiles` first, then figures,
   * TikZ pictures and PDFs. None when no input file exists.
   *
   * @param extraMediaFiles - Additional media files to include, typically the
   *   user-provided `mediaFiles` from the agent config.
   */
  processInputFiles(
    inputFiles: readonly FileLocation[],
    cfg: DocumentTaskOptions,
    extraMediaFiles: readonly FileLocation[] = [],
  ): Effect.Effect<FileLocation[], Error, MediaServices> {
    return Effect.gen({ self: this }, function* () {
      if (inputFiles.length === 0) {
        return [];
      }

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

      if (existingFiles.length === 0) {
        return [];
      }

      const media = [...extraMediaFiles];
      if (cfg.autoExtractFigure) {
        media.push(...(yield* this.extractFiguresFromFiles(existingFiles)));
      }

      yield* this.mirrorLatexFileDependencies(existingFiles);

      if (cfg.autoExtractTikzFigure) {
        media.push(...(yield* this.compileTikzFigures(existingFiles)));
      }

      if (cfg.autoCompileInputPdf) {
        media.push(...(yield* this.compilePdfs(existingFiles)));
      }
      return media;
    });
  }
}
