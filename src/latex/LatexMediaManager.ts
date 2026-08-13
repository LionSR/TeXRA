// Node imports
import * as path from 'node:path';

// Third-party imports
import pMap from 'p-map';

// Local imports
import type { AgentTrace } from '@agent/trace/AgentTrace';
import { platform } from '@platform/platform';
import type { FileLocation } from '@shared/schemas';
import { ToolConfig } from '@shared/schemas/toolConfig';
import { filterNotNullish } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
import { toErrorMessage } from '@utils/errors/errorMessage';
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

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(
    private readonly logger: AgentTrace,
    private readonly fileService?: TaskRunFileService,
  ) {}

  private async mirrorFigureDependencies(
    latexFile: FileLocation,
    figures: string[],
    baseDir?: string,
  ): Promise<void> {
    const fileService = this.fileService;
    if (!fileService || figures.length === 0) {
      return;
    }

    // Resolve against the workspace directory so figure paths from a
    // run-storage symlink map back to real workspace files (otherwise
    // mirrorWorkspaceFile would classify them as external and skip).
    // Callers that already resolved this for their own purposes (e.g.
    // extractFiguresFromFiles) pass it in to avoid a redundant async lookup.
    const resolvedBaseDir =
      baseDir ?? (await resolveLatexDir(latexFile.absolutePath));
    const absolutePaths = new Set<string>();
    for (const relative of figures) {
      const trimmed = relative?.trim();
      if (!trimmed) {
        continue;
      }
      absolutePaths.add(path.normalize(path.join(resolvedBaseDir, trimmed)));
    }

    if (absolutePaths.size === 0) {
      return;
    }

    await pMap(
      [...absolutePaths],
      async (absolutePath) => {
        try {
          await fileService.mirrorWorkspaceFile(pathToLocation(absolutePath));
        } catch (error) {
          this.logger.debug('Unable to mirror figure dependency', {
            data: { path: absolutePath, error },
          });
        }
      },
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
    );
  }

  /**
   * Compile LaTeX files to PDF and add them to the tool state.
   */
  private async compilePdfs(
    files: FileLocation[],
    workspaceState: MediaWorkspaceState,
  ): Promise<void> {
    const texFiles = files.filter((file) =>
      hasExtension(file.absolutePath, '.tex'),
    );

    const compileResults = await pMap(
      texFiles,
      async (file): Promise<FileLocation | undefined> => {
        try {
          const buildDir = path.join(path.dirname(file.absolutePath), 'build');
          await AbsoluteFS.ensureDir(buildDir);
          const compiled = await compileLatex2Pdf(file, {
            outputDirectory: buildDir,
          });
          if (!compiled.ok) {
            this.logger.warn(
              `Failed to compile LaTeX to PDF:\n${compiled.logTail}`,
              {
                data: {
                  sourceFile: file.absolutePath,
                  logTail: compiled.logTail,
                },
              },
            );
            return undefined;
          }

          const pdfFile = path.join(
            buildDir,
            path.basename(file.absolutePath).replace(/\.tex$/, '.pdf'),
          );
          const pdfLocation = pathToLocation(pdfFile);
          if (!(await AbsoluteFS.exists(pdfLocation.absolutePath)))
            return undefined;

          // Stat failures are noisier than other compile failures because an
          // existing-but-unreadable PDF likely indicates a permissions/IO bug.
          const stats = await AbsoluteFS.stat(pdfLocation.absolutePath).catch(
            (err) => {
              this.logger.error(
                `Failed to stat compiled PDF ${pdfLocation.absolutePath}: ${toErrorMessage(err)}`,
                { data: { path: pdfLocation.absolutePath, error: err } },
              );
              return undefined;
            },
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
        } catch {
          // Silent skip: pMap with stopOnError: false continues past
          // individual compile failures (compileLatex2Pdf already logs).
          return undefined;
        }
      },
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
    );

    for (const result of compileResults.filter(filterNotNullish)) {
      workspaceState.media.addMediaFiles([result]);
    }
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
  private async mirrorLatexFileDependencies(
    files: FileLocation[],
  ): Promise<void> {
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

    // Sweep siblings of every root input file up front. Resolve the real
    // path first so a mirrored symlink inside run storage points back to
    // the original workspace tree — otherwise project-local .cls/.sty/.bst/
    // latexmkrc files that live beside the real source are invisible.
    await pMap(
      texFiles,
      async (file) => {
        let siblingDir = path.dirname(file.absolutePath);
        try {
          siblingDir = path.dirname(
            await platform().fs.realPath(file.absolutePath),
          );
        } catch (error) {
          this.logger.debug('Unable to resolve real path', {
            data: { path: file.absolutePath, error },
          });
        }
        await this.mirrorProjectSiblings(siblingDir);
      },
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
    );

    while (worklist.length > 0) {
      const file = worklist.shift()!;
      if (visited.has(file.absolutePath)) continue;
      visited.add(file.absolutePath);

      const deps = await this.collectDependencies(file);
      if (deps.length === 0) continue;

      await pMap(
        deps,
        async (absolutePath) => {
          const depLocation = pathToLocation(absolutePath);
          const isTex = hasExtension(absolutePath, '.tex');
          try {
            await fileService.mirrorWorkspaceFile(depLocation, {
              snapshot: isTex,
            });
            if (isTex) {
              worklist.push(depLocation);
            }
          } catch (error) {
            this.logger.debug('Unable to mirror LaTeX dependency', {
              data: { path: absolutePath, error },
            });
          }
        },
        { concurrency: LATEX_CONCURRENCY, stopOnError: false },
      );
      this.logger.debug('Mirrored LaTeX dependencies', {
        data: { count: deps.length, from: file.absolutePath },
      });
    }
  }

  /**
   * Extract direct \input / \include / \bibliography targets plus any local
   * \usepackage{name} whose `name.sty` sits beside the current file or its
   * project root.
   */
  private async collectDependencies(
    latexFile: FileLocation,
  ): Promise<string[]> {
    const found = new Set<string>();

    try {
      const direct = await extractLatexFileDependencies(latexFile);
      for (const abs of direct) {
        found.add(abs);
      }
    } catch (error) {
      this.logger.debug('Unable to extract LaTeX dependencies', {
        data: { path: latexFile.absolutePath, error },
      });
    }

    try {
      const realPath = await platform().fs.realPath(latexFile.absolutePath);
      const content = await AbsoluteFS.read(latexFile.absolutePath);
      const uncommented = stripLatexComments(content);
      const baseDir = path.dirname(realPath);

      const packageNames = collectCommaSeparatedMatches(
        uncommented,
        USEPACKAGE_PATTERN,
      );
      for (const name of packageNames) {
        const candidate = path.join(baseDir, `${name}.sty`);
        if (await AbsoluteFS.exists(candidate)) {
          found.add(candidate);
        }
      }
    } catch (error) {
      this.logger.debug('Unable to probe \\usepackage targets', {
        data: { path: latexFile.absolutePath, error },
      });
    }

    return [...found];
  }

  /**
   * Shallow scan of a LaTeX project directory for common sibling files
   * (*.cls, *.sty, *.bst, latexmkrc, .latexindentrc) and mirror them into
   * run storage so the compiled document can find its project-local style.
   */
  private async mirrorProjectSiblings(projectDir: string): Promise<void> {
    const fileService = this.fileService;
    if (!fileService) return;

    let entries: string[];
    try {
      entries = (await platform().fs.readDirectory(projectDir)).map(
        ([name]) => name,
      );
    } catch (error) {
      this.logger.debug('Unable to scan project siblings', {
        data: { path: projectDir, error },
      });
      return;
    }

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

    await pMap(
      candidates,
      async (absolutePath) => {
        try {
          const stats = await platform().fs.stat(absolutePath);
          if (!isFile(stats.type)) return;
          await fileService.mirrorWorkspaceFile(pathToLocation(absolutePath));
        } catch (error) {
          this.logger.debug('Unable to mirror project sibling', {
            data: { path: absolutePath, error },
          });
        }
      },
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
    );
  }

  /**
   * Mirror figure dependencies from LaTeX files into run storage without
   * adding figures to the model's vision context. Used for output files
   * (round 1+) so newly-referenced figures are available for PDF compilation
   * but not re-sent to the model on every round.
   */
  private async mirrorFiguresForFiles(files: FileLocation[]): Promise<void> {
    if (!this.fileService || files.length === 0) {
      return;
    }

    const texFiles = files.filter((file) =>
      hasExtension(file.absolutePath, '.tex'),
    );
    if (texFiles.length === 0) return;

    await pMap(
      texFiles,
      async (file) => {
        try {
          const figures = await extractFigurePathsFromLatex(file);
          if (figures.length === 0) return;
          await this.mirrorFigureDependencies(file, figures);
        } catch (error) {
          this.logger.debug('Unable to mirror figures', {
            data: { path: file.absolutePath, error },
          });
        }
      },
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
    );
  }

  private async extractFiguresFromFiles(
    files: FileLocation[],
    workspaceState: MediaWorkspaceState,
  ): Promise<void> {
    const figureResults = await pMap(
      files,
      async (file): Promise<{ file: FileLocation; figures: string[] }> => {
        try {
          const figures = await extractFigurePathsFromLatex(file);
          return { file, figures };
        } catch {
          // Silent skip: malformed or unreadable .tex files should not abort
          // the surrounding pMap. Existence/format errors here are common
          // (e.g. file deleted mid-run) and not worth user-visible noise.
          return { file, figures: [] };
        }
      },
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
    );

    const mirrorTasks: Promise<void>[] = [];

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
      const baseDir = await resolveLatexDir(file.absolutePath);
      const fileLocations = figures.map((relativePath) =>
        pathToLocation(path.normalize(path.join(baseDir, relativePath))),
      );

      // A figure that no longer exists cannot be compiled into the PDF or
      // attached to vision context, so it must not enter media. The resolution
      // above re-derives baseDir (unlike extractFigurePathsFromLatex, whose
      // paths were checked against the original latexDir), so this filter is a
      // real gate, not a re-check of already-known data.
      const existingLocations: FileLocation[] = [];
      for (const loc of fileLocations) {
        if (!(await AbsoluteFS.exists(loc.absolutePath))) {
          this.logger.debug('Extracted figure path does not exist', {
            data: { figurePath: loc.absolutePath, from: file.absolutePath },
          });
          continue;
        }
        existingLocations.push(loc);
      }

      workspaceState.media.addMediaFiles(existingLocations);
      mirrorTasks.push(this.mirrorFigureDependencies(file, figures, baseDir));
    }

    if (mirrorTasks.length > 0) {
      await Promise.all(mirrorTasks);
    }
  }

  private async compileTikzFigures(
    files: FileLocation[],
    workspaceState: MediaWorkspaceState,
    logSummary: boolean,
  ): Promise<void> {
    const tikzResults = await pMap(
      files,
      async (file): Promise<FileLocation[]> => {
        try {
          return await TikzPictureManager.compile(file);
        } catch {
          // Silent skip: TikZ compilation failures are reported by the
          // TikzPictureManager itself; pMap with stopOnError: false must
          // continue past individual failures.
          return [];
        }
      },
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
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
  }

  private async processFiles(
    files: FileLocation[],
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
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }

    const existingFilesInfo = await pMap(
      files,
      async (file) => ({
        file,
        exists: await AbsoluteFS.exists(file.absolutePath),
      }),
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
    );
    const existingFiles = existingFilesInfo
      .filter((f) => f.exists)
      .map((f) => f.file);

    if (existingFiles.length === 0) {
      return;
    }

    if (extraMediaFiles.length > 0) {
      workspaceState.media.addMediaFiles(extraMediaFiles);
    }

    if (cfg.autoExtractFigure) {
      if (figureMode === 'extract') {
        await this.extractFiguresFromFiles(existingFiles, workspaceState);
      } else {
        await this.mirrorFiguresForFiles(existingFiles);
      }
    }

    await this.mirrorLatexFileDependencies(existingFiles);

    if (cfg.autoExtractTikzFigure) {
      await this.compileTikzFigures(
        existingFiles,
        workspaceState,
        logTikzSummary,
      );
    }

    if (cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, workspaceState);
    }
  }

  /**
   * Process input files to extract figures, compile TikZ pictures and PDFs.
   * Adds resulting media paths through the provided media workspace state.
   *
   * @param extraMediaFiles - Additional media files to include, typically the
   *   user-provided `mediaFiles` from the agent config.
   */
  async processInputFiles(
    inputFiles: FileLocation[],
    workspaceState: MediaWorkspaceState,
    cfg: ToolConfig,
    extraMediaFiles: readonly FileLocation[] = [],
  ): Promise<void> {
    await this.processFiles(inputFiles, workspaceState, cfg, {
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
  async processOutputFiles(
    outputFiles: FileLocation[],
    workspaceState: MediaWorkspaceState,
    cfg: ToolConfig,
  ): Promise<void> {
    await this.processFiles(outputFiles, workspaceState, cfg, {
      figureMode: 'mirror',
    });
  }
}
