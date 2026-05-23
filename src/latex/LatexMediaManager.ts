import * as path from 'path';

import pMap from 'p-map';

import { platform } from '@platform/platform';
import type { AgentTrace } from '@agent/trace';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';

import { toErrorMessage } from '@common/errors';
import { isFile } from '@common/files/fsEntryType';
import { ToolConfig } from '@shared/schemas/toolConfig';
import {
  TaskRunFileService,
  flexibleFS,
  pathToLocation,
  type FileLocation,
} from '@utils/files';
import { hasExtension } from '@utils/core/pathCore';

// Local file imports
import { extractLatexFileDependencies } from './extractFileDependencies';
import { extractFigurePathsFromLatex } from './extractFigure';
import { resolveLatexDir } from './latexParsingUtils';
import { tikzPictureManager } from './TikzPictureManager';
import { stripLatexComments } from './latexParsingUtils';
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
 * Flexible input type that accepts either a string path or FileLocation.
 * Provides API consistency while maintaining caller convenience.
 */
type PathInput = string | FileLocation;

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(
    private readonly logger: AgentTrace,
    private readonly fileService?: TaskRunFileService,
  ) {}

  /**
   * Resolve a figure path (relative to the LaTeX directory) to an absolute,
   * normalized path. Mirrors the resolution used inside
   * `extractFigurePathsFromLatex` so figure paths returned from a symlinked
   * run-storage `.tex` map back to their real workspace location.
   */
  private resolveFigureAbsolutePath(
    baseDir: string,
    relativePath: string,
  ): string {
    return path.normalize(path.join(baseDir, relativePath));
  }

  private async mirrorFigureDependencies(
    latexFile: FileLocation,
    figures: string[],
  ): Promise<void> {
    if (!this.fileService?.hasRunDirectory() || figures.length === 0) {
      return;
    }

    // Resolve against the workspace directory so figure paths from a
    // run-storage symlink map back to real workspace files (otherwise
    // mirrorWorkspaceFile would classify them as external and skip).
    const baseDir = await resolveLatexDir(latexFile.absolutePath);
    const absolutePaths = new Set<string>();
    for (const relative of figures) {
      const trimmed = relative?.trim();
      if (!trimmed) {
        continue;
      }
      absolutePaths.add(this.resolveFigureAbsolutePath(baseDir, trimmed));
    }

    if (absolutePaths.size === 0) {
      return;
    }

    const tasks = [...absolutePaths].map(async (absolutePath) => {
      try {
        await this.fileService!.mirrorWorkspaceFile(
          pathToLocation(absolutePath),
        );
      } catch (error) {
        const message = toErrorMessage(error);
        this.logger.debug(
          `Unable to mirror figure dependency ${absolutePath}: ${message}`,
        );
      }
    });

    await Promise.all(tasks);
  }

  /**
   * Compile LaTeX files to PDF and add them to the tool state.
   */
  private async compilePdfs(
    files: FileLocation[],
    workspaceState: AgentWorkspaceState,
  ): Promise<void> {
    const texFiles = files.filter((file) =>
      hasExtension(file.absolutePath, '.tex'),
    );

    const compileResults = await pMap(
      texFiles,
      async (file): Promise<FileLocation | undefined> => {
        try {
          const buildDir = path.join(path.dirname(file.absolutePath), 'build');
          await flexibleFS.ensureDir(pathToLocation(buildDir));
          const compiled = await compileLatex2Pdf(file, {
            outputDirectory: buildDir,
          });
          if (!compiled) return undefined;

          const pdfFile = path.join(
            buildDir,
            path.basename(file.absolutePath).replace(/\.tex$/, '.pdf'),
          );
          const pdfLocation = pathToLocation(pdfFile);
          if (!(await flexibleFS.exists(pdfLocation))) return undefined;

          // Stat failures are noisier than other compile failures because an
          // existing-but-unreadable PDF likely indicates a permissions/IO bug.
          const stats = await flexibleFS.stat(pdfLocation).catch((err) => {
            this.logger.error(
              `Failed to stat compiled PDF ${pdfLocation.absolutePath}: ${toErrorMessage(err)}`,
            );
            return undefined;
          });
          if (!stats) return undefined;
          if (stats.size === 0) {
            this.logger.warn(
              `Compiled PDF is empty for ${file.absolutePath}: ${pdfLocation.absolutePath}`,
            );
            return undefined;
          }

          this.logger.info(
            `Compiled PDF for ${file.absolutePath}: ${pdfLocation.absolutePath}`,
          );
          return pdfLocation;
        } catch {
          // Silent skip: pMap with stopOnError: false continues past
          // individual compile failures (compileLatex2Pdf already logs).
          return undefined;
        }
      },
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
    );

    for (const result of compileResults) {
      if (result) {
        workspaceState.media.addMediaFiles([result]);
      }
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
    if (!this.fileService?.hasRunDirectory() || files.length === 0) {
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
    await Promise.all(
      texFiles.map(async (file) => {
        let siblingDir = path.dirname(file.absolutePath);
        try {
          siblingDir = path.dirname(
            await platform().fs.realPath(file.absolutePath),
          );
        } catch (error) {
          this.logger.debug(
            `Unable to resolve real path for ${file.absolutePath}: ${toErrorMessage(error)}`,
          );
        }
        await this.mirrorProjectSiblings(siblingDir);
      }),
    );

    while (worklist.length > 0) {
      const file = worklist.shift()!;
      if (visited.has(file.absolutePath)) continue;
      visited.add(file.absolutePath);

      const deps = await this.collectDependencies(file);
      if (deps.length === 0) continue;

      await Promise.all(
        deps.map(async (absolutePath) => {
          const depLocation = pathToLocation(absolutePath);
          try {
            await this.fileService!.mirrorWorkspaceFile(depLocation);
            if (hasExtension(absolutePath, '.tex')) {
              worklist.push(depLocation);
            }
          } catch (error) {
            this.logger.debug(
              `Unable to mirror LaTeX dependency ${absolutePath}: ${toErrorMessage(error)}`,
            );
          }
        }),
      );
      this.logger.debug(
        `Mirrored ${deps.length} LaTeX dependencies from ${file.absolutePath}`,
      );
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
      this.logger.debug(
        `Unable to extract LaTeX dependencies from ${latexFile.absolutePath}: ${toErrorMessage(error)}`,
      );
    }

    try {
      const realPath = await platform().fs.realPath(latexFile.absolutePath);
      const content = await flexibleFS.read(latexFile);
      const uncommented = stripLatexComments(content);
      const baseDir = path.dirname(realPath);

      for (const match of uncommented.matchAll(USEPACKAGE_PATTERN)) {
        for (const entry of match[1].split(',')) {
          const name = entry.trim();
          if (!name) continue;
          const candidate = path.join(baseDir, `${name}.sty`);
          if (
            await flexibleFS.exists({
              kind: 'external',
              absolutePath: candidate,
            })
          ) {
            found.add(candidate);
          }
        }
      }
    } catch (error) {
      this.logger.debug(
        `Unable to probe \\usepackage targets in ${latexFile.absolutePath}: ${toErrorMessage(error)}`,
      );
    }

    return [...found];
  }

  /**
   * Shallow scan of a LaTeX project directory for common sibling files
   * (*.cls, *.sty, *.bst, latexmkrc, .latexindentrc) and mirror them into
   * run storage so the compiled document can find its project-local style.
   */
  private async mirrorProjectSiblings(projectDir: string): Promise<void> {
    if (!this.fileService) return;

    let entries: string[];
    try {
      entries = (await platform().fs.readDirectory(projectDir)).map(
        ([name]) => name,
      );
    } catch (error) {
      this.logger.debug(
        `Unable to scan project siblings in ${projectDir}: ${toErrorMessage(error)}`,
      );
      return;
    }

    const candidates: string[] = [];
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      if (
        PROJECT_SIBLING_EXTENSIONS.has(ext) ||
        PROJECT_SIBLING_NAMES.has(name)
      ) {
        candidates.push(path.join(projectDir, name));
      }
    }

    if (candidates.length === 0) return;

    await Promise.all(
      candidates.map(async (absolutePath) => {
        try {
          const stats = await platform().fs.stat(absolutePath);
          if (!isFile(stats.type)) return;
          await this.fileService!.mirrorWorkspaceFile(
            pathToLocation(absolutePath),
          );
        } catch (error) {
          this.logger.debug(
            `Unable to mirror project sibling ${absolutePath}: ${toErrorMessage(error)}`,
          );
        }
      }),
    );
  }

  /**
   * Mirror figure dependencies from LaTeX files into run storage without
   * adding figures to the model's vision context. Used for output files
   * (round 1+) so newly-referenced figures are available for PDF compilation
   * but not re-sent to the model on every round.
   */
  private async mirrorFiguresForFiles(files: FileLocation[]): Promise<void> {
    if (!this.fileService?.hasRunDirectory() || files.length === 0) {
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
          this.logger.debug(
            `Unable to mirror figures from ${file.absolutePath}: ${toErrorMessage(error)}`,
          );
        }
      },
      { concurrency: LATEX_CONCURRENCY, stopOnError: false },
    );
  }

  private async extractFiguresFromFiles(
    files: FileLocation[],
    workspaceState: AgentWorkspaceState,
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

      this.logger.debug(
        `Extracted ${figures.length} figures from ${file.absolutePath}`,
      );

      // Match the resolution in extractFigurePathsFromLatex so the returned
      // figure paths (relative to the real latexDir) map back to workspace
      // files when the .tex is symlinked into run storage.
      const baseDir = await resolveLatexDir(file.absolutePath);
      const fileLocations = figures.map((relativePath) =>
        pathToLocation(this.resolveFigureAbsolutePath(baseDir, relativePath)),
      );

      const existenceChecks = await Promise.all(
        fileLocations.map(async (loc) => ({
          loc,
          exists: await flexibleFS.exists(loc),
        })),
      );

      for (const { loc, exists } of existenceChecks) {
        if (!exists) {
          this.logger.debug(
            `Extracted figure path does not exist: ${loc.absolutePath} (from ${file.absolutePath})`,
          );
        }
      }

      workspaceState.media.addMediaFiles(fileLocations);
      mirrorTasks.push(this.mirrorFigureDependencies(file, figures));
    }

    if (mirrorTasks.length > 0) {
      await Promise.all(mirrorTasks);
    }
  }

  private async compileTikzFigures(
    files: FileLocation[],
    workspaceState: AgentWorkspaceState,
    logSummary: boolean,
  ): Promise<void> {
    const tikzResults = await pMap(
      files,
      async (file): Promise<FileLocation[]> => {
        try {
          return await tikzPictureManager.compile(file);
        } catch {
          // Silent skip: TikZ compilation failures are reported by the
          // tikzPictureManager itself; pMap with stopOnError: false must
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
    workspaceState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
    {
      figureMode,
      mirrorFileDependencies,
      includeTikzCompilation,
      includePdfCompilation,
      extraMediaFiles = [],
      logTikzSummary = false,
    }: {
      /**
       * How to handle \includegraphics figures:
       *  - 'extract': discover + add to vision context + mirror into run storage
       *  - 'mirror':  discover + mirror only (no vision)
       *  - 'none':    skip
       * All modes are additionally gated by `cfg.autoExtractFigure`.
       */
      figureMode: 'extract' | 'mirror' | 'none';
      mirrorFileDependencies: boolean;
      includeTikzCompilation: boolean;
      includePdfCompilation: boolean;
      extraMediaFiles?: PathInput[];
      logTikzSummary?: boolean;
    },
  ): Promise<void> {
    if (files.length === 0 || !supportsVision) {
      return;
    }

    const existingFilesInfo = await Promise.all(
      files.map(async (file) => ({
        file,
        exists: await flexibleFS.exists(file),
      })),
    );
    const existingFiles = existingFilesInfo
      .filter((f) => f.exists)
      .map((f) => f.file);

    if (existingFiles.length === 0) {
      return;
    }

    if (extraMediaFiles.length > 0) {
      const fileLocations = extraMediaFiles.map((input) =>
        typeof input === 'string' ? pathToLocation(input) : input,
      );
      workspaceState.media.addMediaFiles(fileLocations);
    }

    if (cfg.autoExtractFigure) {
      if (figureMode === 'extract') {
        await this.extractFiguresFromFiles(existingFiles, workspaceState);
      } else if (figureMode === 'mirror') {
        await this.mirrorFiguresForFiles(existingFiles);
      }
    }

    if (mirrorFileDependencies) {
      await this.mirrorLatexFileDependencies(existingFiles);
    }

    if (includeTikzCompilation && cfg.autoExtractTikzFigure) {
      await this.compileTikzFigures(
        existingFiles,
        workspaceState,
        logTikzSummary,
      );
    }

    if (includePdfCompilation && cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, workspaceState);
    }
  }

  /**
   * Process input files to extract figures, compile TikZ pictures and PDFs.
   * Adds resulting media paths to the provided AgentWorkspaceState.
   *
   * @param extraMediaFiles - Additional media files to include.
   *   Accepts both string paths and FileLocation objects for API flexibility.
   *   Typically user-provided paths from agent config (mediaFile, mediaFiles).
   */
  async processInputFiles(
    inputFiles: FileLocation[],
    workspaceState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
    extraMediaFiles: PathInput[] = [],
  ): Promise<void> {
    await this.processFiles(inputFiles, workspaceState, cfg, supportsVision, {
      figureMode: 'extract',
      mirrorFileDependencies: true,
      includeTikzCompilation: true,
      includePdfCompilation: true,
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
    workspaceState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
  ): Promise<void> {
    await this.processFiles(outputFiles, workspaceState, cfg, supportsVision, {
      figureMode: 'mirror',
      mirrorFileDependencies: true,
      includeTikzCompilation: true,
      includePdfCompilation: true,
    });
  }
}
