// Standard library imports
import * as path from 'path';

// Local imports - log
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { ToolConfig } from '@agent/core/ToolConfig';
import { toErrorMessage } from '@common/errors';
import { AgentLogger } from '@logger/AgentLogger';
import { TaskRunFileService, flexibleFS, pathToLocation } from '@utils/files';

// Local file imports
import { extractFigurePathsFromLatex } from './extractFigure';
import { tikzPictureManager } from './TikzPictureManager';
import { compileLatex2Pdf } from './texTools';
import { getTeXCountStats } from './texcount';

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(
    private readonly logger: AgentLogger,
    private readonly fileService?: TaskRunFileService,
  ) {}

  private async mirrorFigureDependencies(
    latexFile: string,
    figures: string[],
    groupId: string | null | undefined,
  ): Promise<void> {
    if (!this.fileService?.hasRunDirectory()) {
      return;
    }

    if (figures.length === 0) {
      return;
    }

    const baseDir = path.dirname(latexFile);
    const targets = new Set<string>();
    for (const relative of figures) {
      if (!relative) {
        continue;
      }
      const trimmed = relative.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const absolute = path.normalize(path.join(baseDir, trimmed));
      targets.add(absolute);
    }

    if (targets.size === 0) {
      return;
    }

    const tasks = Array.from(targets).map(async (target) => {
      try {
        await this.fileService!.mirrorWorkspaceFile(target);
      } catch (error) {
        const message = toErrorMessage(error);
        this.logger.debug(
          `Unable to mirror figure dependency ${target}: ${message}`,
          groupId ?? undefined,
        );
      }
    });

    await Promise.all(tasks);
  }

  private async attachTeXCount(
    files: string[],
    workspaceState: AgentWorkspaceState,
    cfg: ToolConfig,
  ): Promise<void> {
    if (cfg.attachTeXCount && files.length > 0) {
      workspaceState.document.texcountStats = await getTeXCountStats(files);
    }
  }

  /**
   * Compile LaTeX files to PDF and add them to the tool state.
   */
  private async compilePdfs(
    files: string[],
    workspaceState: AgentWorkspaceState,
  ): Promise<void> {
    const activeGroupId = this.logger.withCurrentGroup((id) => id);
    const texFiles = files.filter((file) =>
      file.toLowerCase().endsWith('.tex'),
    );
    const compileResults = await Promise.allSettled(
      texFiles.map(async (file) => {
        const buildDir = path.join(path.dirname(file), 'build');
        await flexibleFS.ensureDir(pathToLocation(buildDir));
        const compiled = await compileLatex2Pdf(
          pathToLocation(file),
          undefined,
          buildDir,
          true,
        );
        if (compiled) {
          const pdfFile = path.join(
            buildDir,
            path.basename(file).replace(/\.tex$/, '.pdf'),
          );
          const pdfLocation = pathToLocation(pdfFile);
          if (await flexibleFS.exists(pdfLocation)) {
            try {
              const stats = await flexibleFS.stat(pdfLocation);
              if (stats.size === 0) {
                this.logger.warn(
                  `Compiled PDF is empty for ${file}: ${pdfFile}`,
                  activeGroupId,
                );
                return undefined;
              }
            } catch (err) {
              const message = toErrorMessage(err);
              this.logger.error(
                `Failed to stat compiled PDF ${pdfFile}: ${message}`,
                activeGroupId,
              );
              return undefined;
            }

            this.logger.info(
              `Compiled PDF for ${file}: ${pdfFile}`,
              activeGroupId,
            );
            return pdfFile;
          }
        }
        return undefined;
      }),
    );
    compileResults.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        workspaceState.media.addMediaFiles([result.value]);
      }
    });
  }

  private async extractFiguresFromFiles(
    files: string[],
    workspaceState: AgentWorkspaceState,
  ): Promise<void> {
    const activeGroupId = this.logger.withCurrentGroup((id) => id);
    const figureResults = await Promise.allSettled(
      files.map((file) => extractFigurePathsFromLatex(file)),
    );

    const mirrorTasks: Promise<void>[] = [];

    figureResults.forEach((result, idx) => {
      if (
        result.status === 'fulfilled' &&
        result.value &&
        result.value.length > 0
      ) {
        const file = files[idx];
        this.logger.debug(
          `Extracted ${result.value.length} figures from ${file}`,
          activeGroupId,
        );
        workspaceState.media.addMediaFiles(result.value);
        mirrorTasks.push(
          this.mirrorFigureDependencies(file, result.value, activeGroupId),
        );
      }
    });

    if (mirrorTasks.length > 0) {
      await Promise.all(mirrorTasks);
    }
  }

  private async compileTikzFigures(
    files: string[],
    workspaceState: AgentWorkspaceState,
    logSummary: boolean,
  ): Promise<void> {
    const activeGroupId = this.logger.withCurrentGroup((id) => id);
    const tikzResults = await Promise.allSettled(
      files.map((file) => tikzPictureManager.compile(file)),
    );
    tikzResults.forEach((result) => {
      if (
        result.status === 'fulfilled' &&
        result.value &&
        result.value.length > 0
      ) {
        workspaceState.media.addMediaFiles(result.value);
      }
    });
    if (logSummary) {
      this.logger.debug(
        `Extracted ${tikzResults.length} TikZ figures`,
        activeGroupId,
      );
    }
  }

  private async processFiles(
    files: string[],
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
      extraMediaFiles?: string[];
      logTikzSummary?: boolean;
    },
  ): Promise<void> {
    if (!files || files.length === 0) {
      return;
    }

    const existingFilesInfo = await Promise.all(
      files.map(async (file) => ({
        file,
        exists: await flexibleFS.exists(pathToLocation(file)),
      })),
    );
    const existingFiles = existingFilesInfo
      .filter((f) => f.exists)
      .map((f) => f.file);

    if (existingFiles.length === 0) {
      return;
    }

    await this.attachTeXCount(existingFiles, workspaceState, cfg);

    if (!supportsVision) {
      return;
    }

    if (extraMediaFiles.length > 0) {
      workspaceState.media.addMediaFiles(extraMediaFiles);
    }

    if (includeFigureExtraction && cfg.autoExtractFigure) {
      await this.extractFiguresFromFiles(existingFiles, workspaceState);
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
   */
  async processInputFiles(
    inputFiles: string[],
    workspaceState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
    extraMediaFiles: string[] = [],
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
    outputFiles: string[],
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
