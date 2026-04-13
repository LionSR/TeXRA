import * as path from 'path';

import pMap from 'p-map';

import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';

import { toErrorMessage } from '@common/errors';
import { AgentLogger } from '@logger/AgentLogger';
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
import { tikzPictureManager } from './TikzPictureManager';
import { compileLatex2Pdf } from './texTools';

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
    private readonly logger: AgentLogger,
    private readonly fileService?: TaskRunFileService,
  ) {}

  private async mirrorFigureDependencies(
    latexFile: FileLocation,
    figures: string[],
  ): Promise<void> {
    if (!this.fileService?.hasRunDirectory() || figures.length === 0) {
      return;
    }

    const baseDir = path.dirname(latexFile.absolutePath);
    const targetLocations = new Set<FileLocation>();
    for (const relative of figures) {
      const trimmed = relative?.trim();
      if (!trimmed) {
        continue;
      }
      const absolutePath = path.normalize(path.join(baseDir, trimmed));
      targetLocations.add(pathToLocation(absolutePath));
    }

    if (targetLocations.size === 0) {
      return;
    }

    const tasks = [...targetLocations].map(async (targetLocation) => {
      try {
        await this.fileService!.mirrorWorkspaceFile(targetLocation);
      } catch (error) {
        const message = toErrorMessage(error);
        this.logger.debug(
          `Unable to mirror figure dependency ${targetLocation.absolutePath}: ${message}`,
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
          if (!compiled) {
            return undefined;
          }
          const pdfFile = path.join(
            buildDir,
            path.basename(file.absolutePath).replace(/\.tex$/, '.pdf'),
          );
          const pdfLocation = pathToLocation(pdfFile);
          if (!(await flexibleFS.exists(pdfLocation))) {
            return undefined;
          }
          try {
            const stats = await flexibleFS.stat(pdfLocation);
            if (stats.size === 0) {
              this.logger.warn(
                `Compiled PDF is empty for ${file.absolutePath}: ${pdfLocation.absolutePath}`,
              );
              return undefined;
            }
          } catch (err) {
            this.logger.error(
              `Failed to stat compiled PDF ${pdfLocation.absolutePath}: ${toErrorMessage(err)}`,
            );
            return undefined;
          }
          this.logger.info(
            `Compiled PDF for ${file.absolutePath}: ${pdfLocation.absolutePath}`,
          );
          return pdfLocation;
        } catch {
          // pMap with stopOnError: false continues on individual failures
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
   * Parse \input, \include, \bibliography, and \addbibresource commands
   * from LaTeX files and mirror the discovered dependencies into run storage.
   * This ensures output files in run storage can be compiled successfully
   * when the main document references other files.
   */
  private async mirrorLatexFileDependencies(
    files: FileLocation[],
  ): Promise<void> {
    if (!this.fileService?.hasRunDirectory() || files.length === 0) {
      return;
    }

    for (const file of files) {
      try {
        const deps = await extractLatexFileDependencies(file);
        if (deps.length === 0) continue;

        const baseDir = path.dirname(file.absolutePath);
        const tasks = deps.map(async (relative) => {
          const absolutePath = path.normalize(path.join(baseDir, relative));
          try {
            await this.fileService!.mirrorWorkspaceFile(
              pathToLocation(absolutePath),
            );
          } catch (error) {
            const message = toErrorMessage(error);
            this.logger.debug(
              `Unable to mirror LaTeX dependency ${absolutePath}: ${message}`,
            );
          }
        });

        await Promise.all(tasks);
        this.logger.debug(
          `Mirrored ${deps.length} LaTeX file dependencies from ${file.absolutePath}`,
        );
      } catch (error) {
        this.logger.debug(
          `Unable to extract LaTeX dependencies from ${file.absolutePath}: ${toErrorMessage(error)}`,
        );
      }
    }
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

      const baseDir = path.dirname(file.absolutePath);
      const fileLocations = figures.map((relativePath) => {
        const absolutePath = path.normalize(path.join(baseDir, relativePath));
        return pathToLocation(absolutePath);
      });

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
      includeFigureExtraction,
      includeTikzCompilation,
      includePdfCompilation,
      extraMediaFiles = [],
      logTikzSummary = false,
    }: {
      includeFigureExtraction: boolean;
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

    if (includeFigureExtraction && cfg.autoExtractFigure) {
      await this.extractFiguresFromFiles(existingFiles, workspaceState);
    }

    if (includeFigureExtraction) {
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
      includeFigureExtraction: true,
      includeTikzCompilation: true,
      includePdfCompilation: true,
      extraMediaFiles,
      logTikzSummary: true,
    });
  }

  /**
   * Process output files to compile TikZ pictures and PDFs, attach texcount.
   */
  async processOutputFiles(
    outputFiles: FileLocation[],
    workspaceState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
  ): Promise<void> {
    await this.processFiles(outputFiles, workspaceState, cfg, supportsVision, {
      includeFigureExtraction: false,
      includeTikzCompilation: true,
      includePdfCompilation: true,
    });
  }
}
