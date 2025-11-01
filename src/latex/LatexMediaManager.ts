// Standard library imports
import * as path from 'path';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - latex utils
import { extractFigurePathsFromLatex } from './extractFigure';
import { tikzPictureManager } from './TikzPictureManager';
import { compileLatex2Pdf } from './texTools';
import { getTeXCountStats } from './texcount';

// Local imports - agent components
import { ToolRuntimeStore } from '@agent/state';
import { ToolConfig } from '@agent/core/ToolConfig';
import { WorkspaceFS } from '@utils/files';

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(private readonly logger: AgentLogger) {}

  private async attachTeXCount(
    files: string[],
    toolState: ToolRuntimeStore,
    cfg: ToolConfig,
  ): Promise<void> {
    if (cfg.attachTeXCount && files.length > 0) {
      toolState.texcountStats = await getTeXCountStats(files);
    }
  }

  /**
   * Compile LaTeX files to PDF and add them to the tool state.
   */
  private async compilePdfs(
    files: string[],
    toolState: ToolRuntimeStore,
    groupId?: string,
  ): Promise<void> {
    const texFiles = files.filter((file) =>
      file.toLowerCase().endsWith('.tex'),
    );
    const compileResults = await Promise.allSettled(
      texFiles.map(async (file) => {
        const buildDir = path.join(path.dirname(file), 'build');
        await WorkspaceFS.ensureDir(buildDir);
        const compiled = await compileLatex2Pdf(
          file,
          undefined,
          buildDir,
          true,
        );
        if (compiled) {
          const pdfFile = path.join(
            buildDir,
            path.basename(file).replace(/\.tex$/, '.pdf'),
          );
          if (await WorkspaceFS.exists(pdfFile)) {
            try {
              const stats = await WorkspaceFS.stat(pdfFile);
              if (stats.size === 0) {
                this.logger.warn(
                  `Compiled PDF is empty for ${file}: ${pdfFile}`,
                  groupId,
                );
                return undefined;
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              this.logger.error(
                `Failed to stat compiled PDF ${pdfFile}: ${message}`,
                groupId,
              );
              return undefined;
            }

            this.logger.info(`Compiled PDF for ${file}: ${pdfFile}`, groupId);
            return pdfFile;
          }
        }
        return undefined;
      }),
    );
    compileResults.forEach((result) => {
      if (result.status === 'fulfilled' && result.value) {
        toolState.addMediaFiles([result.value]);
      }
    });
  }

  private async extractFiguresFromFiles(
    files: string[],
    toolState: ToolRuntimeStore,
    groupId?: string,
  ): Promise<void> {
    const figureResults = await Promise.allSettled(
      files.map((file) => extractFigurePathsFromLatex(file)),
    );
    figureResults.forEach((result, idx) => {
      if (
        result.status === 'fulfilled' &&
        result.value &&
        result.value.length > 0
      ) {
        const file = files[idx];
        this.logger.debug(
          `Extracted ${result.value.length} figures from ${file}`,
          groupId,
        );
        toolState.addMediaFiles(result.value);
      }
    });
  }

  private async compileTikzFigures(
    files: string[],
    toolState: ToolRuntimeStore,
    logSummary: boolean,
    groupId?: string,
  ): Promise<void> {
    const tikzResults = await Promise.allSettled(
      files.map((file) => tikzPictureManager.compile(file)),
    );
    tikzResults.forEach((result) => {
      if (
        result.status === 'fulfilled' &&
        result.value &&
        result.value.length > 0
      ) {
        toolState.addMediaFiles(result.value);
      }
    });
    if (logSummary) {
      this.logger.debug(
        `Extracted ${tikzResults.length} TikZ figures`,
        groupId,
      );
    }
  }

  private async processFiles(
    files: string[],
    toolState: ToolRuntimeStore,
    cfg: ToolConfig,
    supportsVision: boolean,
    {
      includeFigureExtraction,
      includeTikzCompilation,
      includePdfCompilation,
      extraMediaFiles = [],
      logTikzSummary = false,
      groupId,
    }: {
      includeFigureExtraction: boolean;
      includeTikzCompilation: boolean;
      includePdfCompilation: boolean;
      extraMediaFiles?: string[];
      logTikzSummary?: boolean;
      groupId?: string;
    },
  ): Promise<void> {
    if (!files || files.length === 0) {
      return;
    }

    const existingFilesInfo = await Promise.all(
      files.map(async (file) => ({
        file,
        exists: await WorkspaceFS.exists(file),
      })),
    );
    const existingFiles = existingFilesInfo
      .filter((f) => f.exists)
      .map((f) => f.file);

    if (existingFiles.length === 0) {
      return;
    }

    await this.attachTeXCount(existingFiles, toolState, cfg);

    if (!supportsVision) {
      return;
    }

    if (extraMediaFiles.length > 0) {
      toolState.addMediaFiles(extraMediaFiles);
    }

    if (includeFigureExtraction && cfg.autoExtractFigure) {
      await this.extractFiguresFromFiles(existingFiles, toolState, groupId);
    }

    if (includeTikzCompilation && cfg.autoExtractTikzFigure) {
      await this.compileTikzFigures(
        existingFiles,
        toolState,
        logTikzSummary,
        groupId,
      );
    }

    if (includePdfCompilation && cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, toolState, groupId);
    }
  }

  /**
   * Process input files to extract figures, compile TikZ pictures and PDFs.
   * Adds resulting media paths to the provided ToolRuntimeStore.
   */
  async processInputFiles(
    inputFiles: string[],
    toolState: ToolRuntimeStore,
    cfg: ToolConfig,
    supportsVision: boolean,
    extraMediaFiles: string[] = [],
    groupId?: string,
  ): Promise<void> {
    await this.processFiles(inputFiles, toolState, cfg, supportsVision, {
      includeFigureExtraction: true,
      includeTikzCompilation: true,
      includePdfCompilation: true,
      extraMediaFiles,
      logTikzSummary: true,
      groupId,
    });
  }

  /**
   * Process output files to compile TikZ pictures and PDFs, attach texcount.
   */
  async processOutputFiles(
    outputFiles: string[],
    toolState: ToolRuntimeStore,
    cfg: ToolConfig,
    supportsVision: boolean,
    groupId?: string,
  ): Promise<void> {
    await this.processFiles(outputFiles, toolState, cfg, supportsVision, {
      includeFigureExtraction: false,
      includeTikzCompilation: true,
      includePdfCompilation: true,
      groupId,
    });
  }
}
