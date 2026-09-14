// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports
import type { FileLocation } from '@shared/schemas';
import { ToolConfig } from '@shared/schemas';
import { filterNotNullish } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { isFile } from '@utils/files/fsEntryType';
import { getExtensionLowercase, hasExtension } from '@utils/core/pathCore';

// Local file imports
import { extractLatexFileDependencies } from './extractFileDependencies';
import { extractFigurePathsFromLatex } from './extractFigure';
import {
  collectCommaSeparatedMatches,
  resolveLatexDir,
  stripLatexComments,
} from './latexParsingUtils';
import { TikzPictureManager } from './TikzPictureManager';
import { compileLatex2Pdf } from './texTools';

/** LaTeX project siblings that should always ride alongside the main file. */
const PROJECT_SIBLING_EXTENSIONS = new Set(['.cls', '.sty', '.bst', '.cfg']);
const PROJECT_SIBLING_NAMES = new Set([
  'latexmkrc',
  '.latexmkrc',
  '.latexindentrc',
]);

const USEPACKAGE_PATTERN =
  /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

/** Maximum concurrent LaTeX compilation operations */
const LATEX_CONCURRENCY = 4;

/**
 * The slice of agent workspace state this manager writes media results into.
 * Structurally satisfied by `AgentWorkspaceState`; declared here so LaTeX
 * processing stays independent of agent execution internals.
 */
export interface MediaWorkspaceState {
  media: { addMediaFiles(locations: readonly FileLocation[]): void };
}

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

/** Run `effect`, reading a filesystem promise as a typed failure. */
const fsCall = <A>(thunk: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: thunk, catch: ensureError });

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(
    private readonly logger: LatexTrace,
    private readonly fileService?: TaskRunFileService,
  ) {}

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
            Effect.sync(() => {
              this.logger.debug(failureMessage, {
                data: { path: pathOf(item), error },
              });
            }),
          ),
        ),
      { concurrency: LATEX_CONCURRENCY, discard: true },
    );
  }

  private mirrorFigureDependencies(
    latexFile: FileLocation,
    figures: readonly string[],
    baseDir?: string,
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      const fileService = this.fileService;
      if (!fileService || figures.length === 0) {
        return;
      }

      // Resolve against the workspace directory so figure paths from a
      // run-storage symlink map back to real workspace files (otherwise
      // mirrorWorkspaceFile would classify them as external and skip).
      // Callers that already resolved this for their own purposes (e.g.
      // extractFiguresFromFiles) pass it in to avoid a redundant lookup.
      const resolvedBaseDir =
        baseDir ?? (yield* resolveLatexDir(latexFile.absolutePath));
      const absolutePaths = new Set<string>();
      for (const relative of figures) {
        const trimmed = relative.trim();
        if (trimmed) {
          absolutePaths.add(
            path.normalize(path.join(resolvedBaseDir, trimmed)),
          );
        }
      }

      if (absolutePaths.size === 0) {
        return;
      }

      yield* this.forEachFile(
        [...absolutePaths],
        (absolutePath) => absolutePath,
        'Unable to mirror figure dependency',
        (absolutePath) =>
          fsCall(() =>
            fileService.mirrorWorkspaceFile(pathToLocation(absolutePath)),
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
  ): Effect.Effect<FileLocation | undefined, Error> {
    return Effect.gen({ self: this }, function* () {
      const buildDir = path.join(path.dirname(file.absolutePath), 'build');
      yield* fsCall(() => AbsoluteFS.ensureDir(buildDir));
      const compiled = yield* fsCall(() =>
        compileLatex2Pdf(file, { outputDirectory: buildDir }),
      );
      if (!compiled.ok) {
        this.logger.warn(
          `Failed to compile LaTeX to PDF:\n${compiled.logTail}`,
          {
            data: { sourceFile: file.absolutePath, logTail: compiled.logTail },
          },
        );
        return undefined;
      }

      const pdfLocation = pathToLocation(compiled.pdfPath);
      const written = yield* fsCall(() =>
        AbsoluteFS.exists(pdfLocation.absolutePath),
      );
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
      const stats = yield* fsCall(() =>
        AbsoluteFS.stat(pdfLocation.absolutePath),
      ).pipe(
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
      if (stats.size === 0) {
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

  /**
   * Compile LaTeX files to PDF and add them to the tool state.
   */
  private compilePdfs(
    files: readonly FileLocation[],
    workspaceState: MediaWorkspaceState,
  ): Effect.Effect<void> {
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

      for (const result of compileResults.filter(filterNotNullish)) {
        workspaceState.media.addMediaFiles([result]);
      }
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
      if (!fileService || files.length === 0) {
        return;
      }

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

        const deps = yield* this.collectDependencies(file);
        if (deps.length === 0) continue;

        yield* this.forEachFile(
          deps,
          (absolutePath) => absolutePath,
          'Unable to mirror LaTeX dependency',
          (absolutePath) =>
            Effect.gen(function* () {
              const depLocation = pathToLocation(absolutePath);
              const isTex = hasExtension(absolutePath, '.tex');
              yield* fsCall(() =>
                fileService.mirrorWorkspaceFile(depLocation, {
                  snapshot: isTex,
                }),
              );
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
   * Extract direct \input / \include / \bibliography targets plus any local
   * \usepackage{name} whose `name.sty` sits beside the current file or its
   * project root.
   */
  private collectDependencies(
    latexFile: FileLocation,
  ): Effect.Effect<string[], never, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      const found = new Set<string>();

      const direct = yield* extractLatexFileDependencies(latexFile).pipe(
        Effect.catch((error) =>
          Effect.sync((): readonly string[] => {
            this.logger.debug('Unable to extract LaTeX dependencies', {
              data: { path: latexFile.absolutePath, error },
            });
            return [];
          }),
        ),
      );
      for (const abs of direct) {
        found.add(abs);
      }

      const local = yield* Effect.gen({ self: this }, function* () {
        // `resolveLatexDir` follows the symlink and falls back to the literal
        // dirname, so a file whose real path can't be resolved still gets its
        // sibling `.sty` files probed instead of skipping the probe entirely.
        const baseDir = yield* resolveLatexDir(latexFile.absolutePath);
        const content = yield* fsCall(() =>
          AbsoluteFS.read(latexFile.absolutePath),
        );
        const uncommented = stripLatexComments(content);

        const candidates = collectCommaSeparatedMatches(
          uncommented,
          USEPACKAGE_PATTERN,
        ).map((name) => path.join(baseDir, `${name}.sty`));

        const probed = yield* Effect.forEach(
          candidates,
          (candidate) =>
            fsCall(() => AbsoluteFS.exists(candidate)).pipe(
              Effect.map((exists) => (exists ? candidate : undefined)),
            ),
          { concurrency: LATEX_CONCURRENCY },
        );
        return probed.filter(filterNotNullish);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync((): readonly string[] => {
            this.logger.debug('Unable to probe \\usepackage targets', {
              data: { path: latexFile.absolutePath, error },
            });
            return [];
          }),
        ),
      );
      for (const abs of local) {
        found.add(abs);
      }

      return [...found];
    });
  }

  /**
   * Shallow scan of a LaTeX project directory for common sibling files
   * (*.cls, *.sty, *.bst, latexmkrc, .latexindentrc) and mirror them into
   * run storage so the compiled document can find its project-local style.
   */
  private mirrorProjectSiblings(projectDir: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const fileService = this.fileService;
      if (!fileService) return;

      const entries = yield* fsCall(() => AbsoluteFS.readDir(projectDir)).pipe(
        Effect.map((read) => read.map(([name]) => name)),
        Effect.catch((error) =>
          Effect.sync((): string[] | undefined => {
            this.logger.debug('Unable to scan project siblings', {
              data: { path: projectDir, error },
            });
            return undefined;
          }),
        ),
      );
      if (!entries) return;

      const candidates: string[] = [];
      for (const name of entries) {
        const ext = getExtensionLowercase(name);
        if (
          PROJECT_SIBLING_EXTENSIONS.has(ext) ||
          PROJECT_SIBLING_NAMES.has(name)
        ) {
          candidates.push(path.join(projectDir, name));
        }
      }

      if (candidates.length === 0) return;

      yield* this.forEachFile(
        candidates,
        (absolutePath) => absolutePath,
        'Unable to mirror project sibling',
        (absolutePath) =>
          Effect.gen(function* () {
            const stats = yield* fsCall(() => AbsoluteFS.stat(absolutePath));
            if (!isFile(stats.type)) return;
            yield* fsCall(() =>
              fileService.mirrorWorkspaceFile(pathToLocation(absolutePath)),
            );
          }),
      );
    });
  }

  /**
   * Mirror figure dependencies from LaTeX files into run storage without
   * adding figures to the model's vision context. Used for output files
   * (round 1+) so newly-referenced figures are available for PDF compilation
   * but not re-sent to the model on every round.
   */
  private mirrorFiguresForFiles(
    files: readonly FileLocation[],
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (!this.fileService || files.length === 0) {
        return;
      }

      const texFiles = files.filter((file) =>
        hasExtension(file.absolutePath, '.tex'),
      );
      if (texFiles.length === 0) return;

      yield* this.forEachFile(
        texFiles,
        (file) => file.absolutePath,
        'Unable to mirror figures',
        (file) =>
          Effect.gen({ self: this }, function* () {
            const figures = yield* extractFigurePathsFromLatex(file);
            if (figures.length === 0) return;
            yield* this.mirrorFigureDependencies(file, figures);
          }),
      );
    });
  }

  private extractFiguresFromFiles(
    files: readonly FileLocation[],
    workspaceState: MediaWorkspaceState,
  ): Effect.Effect<void, Error, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      const figureResults = yield* Effect.forEach(
        files,
        (file) =>
          extractFigurePathsFromLatex(file).pipe(
            // Silent skip: malformed or unreadable .tex files should not abort
            // the surrounding fan-out. Existence/format errors here are common
            // (e.g. file deleted mid-run) and not worth user-visible noise.
            Effect.catch(() => Effect.succeed<readonly string[]>([])),
            Effect.map((figures) => ({ file, figures })),
          ),
        { concurrency: LATEX_CONCURRENCY },
      );

      const mirrors: Effect.Effect<void, never, FileSystem.FileSystem>[] = [];

      for (const { file, figures } of figureResults) {
        if (figures.length === 0) {
          continue;
        }

        this.logger.debug('Extracted figures', {
          data: { count: figures.length, from: file.absolutePath },
        });

        // Match the resolution in extractFigurePathsFromLatex so the returned
        // figure paths (relative to the real latexDir) map back to workspace
        // files when the .tex is symlinked into run storage.
        const baseDir = yield* resolveLatexDir(file.absolutePath);
        const fileLocations = figures.map((relativePath) =>
          pathToLocation(path.normalize(path.join(baseDir, relativePath))),
        );

        // A figure that no longer exists cannot be compiled into the PDF or
        // attached to vision context, so it must not enter media. The
        // resolution above re-derives baseDir (unlike
        // extractFigurePathsFromLatex, whose paths were checked against the
        // original latexDir), so this filter is a real gate, not a re-check of
        // already-known data.
        const probed = yield* Effect.forEach(
          fileLocations,
          (loc) =>
            fsCall(() => AbsoluteFS.exists(loc.absolutePath)).pipe(
              Effect.map((exists) => ({ loc, exists })),
            ),
          { concurrency: LATEX_CONCURRENCY },
        );
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

        workspaceState.media.addMediaFiles(existingLocations);
        mirrors.push(this.mirrorFigureDependencies(file, figures, baseDir));
      }

      yield* Effect.all(mirrors, {
        concurrency: LATEX_CONCURRENCY,
        discard: true,
      });
    });
  }

  private compileTikzFigures(
    files: readonly FileLocation[],
    workspaceState: MediaWorkspaceState,
    logSummary: boolean,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const tikzResults = yield* Effect.forEach(
        files,
        (file) =>
          fsCall(() => TikzPictureManager.compile(file)).pipe(
            // Silent skip: TikZ compilation failures are reported by the
            // TikzPictureManager itself; the fan-out must continue past
            // individual failures.
            Effect.catch(() => Effect.succeed<FileLocation[]>([])),
          ),
        { concurrency: LATEX_CONCURRENCY },
      );

      for (const r of tikzResults) {
        if (r.length > 0) {
          workspaceState.media.addMediaFiles(r);
        }
      }

      if (logSummary) {
        const totalFigures = tikzResults.reduce((sum, r) => sum + r.length, 0);
        this.logger.debug(`Extracted ${totalFigures} TikZ figures`);
      }
    });
  }

  private processFiles(
    files: readonly FileLocation[],
    workspaceState: MediaWorkspaceState,
    cfg: ToolConfig,
    {
      figureMode,
      extraMediaFiles = [],
      logTikzSummary = false,
    }: {
      /**
       * How to handle \includegraphics figures:
       *  - 'extract': discover + add to vision context + mirror into run storage
       *  - 'mirror':  discover + mirror only (no vision)
       * Both modes are additionally gated by `cfg.autoExtractFigure`.
       */
      figureMode: 'extract' | 'mirror';
      extraMediaFiles?: readonly FileLocation[];
      logTikzSummary?: boolean;
    },
  ): Effect.Effect<void, Error, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      if (files.length === 0) {
        return;
      }

      const probed = yield* Effect.forEach(
        files,
        (file) =>
          fsCall(() => AbsoluteFS.exists(file.absolutePath)).pipe(
            Effect.map((exists) => ({ file, exists })),
          ),
        { concurrency: LATEX_CONCURRENCY },
      );
      const existingFiles = probed
        .filter((entry) => entry.exists)
        .map((entry) => entry.file);

      if (existingFiles.length === 0) {
        return;
      }

      if (extraMediaFiles.length > 0) {
        workspaceState.media.addMediaFiles(extraMediaFiles);
      }

      if (cfg.autoExtractFigure) {
        yield* figureMode === 'extract'
          ? this.extractFiguresFromFiles(existingFiles, workspaceState)
          : this.mirrorFiguresForFiles(existingFiles);
      }

      yield* this.mirrorLatexFileDependencies(existingFiles);

      if (cfg.autoExtractTikzFigure) {
        yield* this.compileTikzFigures(
          existingFiles,
          workspaceState,
          logTikzSummary,
        );
      }

      if (cfg.autoCompileInputPdf) {
        yield* this.compilePdfs(existingFiles, workspaceState);
      }
    });
  }

  /**
   * Process input files to extract figures, compile TikZ pictures and PDFs.
   * Adds resulting media paths through the provided media workspace state.
   *
   * @param extraMediaFiles - Additional media files to include, typically the
   *   user-provided `mediaFiles` from the agent config.
   */
  processInputFiles(
    inputFiles: readonly FileLocation[],
    workspaceState: MediaWorkspaceState,
    cfg: ToolConfig,
    extraMediaFiles: readonly FileLocation[] = [],
  ): Effect.Effect<void, Error, FileSystem.FileSystem> {
    return this.processFiles(inputFiles, workspaceState, cfg, {
      figureMode: 'extract',
      extraMediaFiles,
      logTikzSummary: true,
    });
  }

  /**
   * Process output files to compile TikZ pictures and PDFs.
   *
   * Mirrors newly-referenced figure and \input dependencies into run storage
   * so agent-introduced references compile outside the workspace. Figures are
   * mirrored only (not added to vision context) — they were sent on round 0.
   */
  processOutputFiles(
    outputFiles: readonly FileLocation[],
    workspaceState: MediaWorkspaceState,
    cfg: ToolConfig,
  ): Effect.Effect<void, Error, FileSystem.FileSystem> {
    return this.processFiles(outputFiles, workspaceState, cfg, {
      figureMode: 'mirror',
    });
  }
}
