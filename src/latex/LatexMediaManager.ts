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
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { ToolConfig } from '@agent/core/ToolConfig';
import { WorkspaceFS } from '@utils/files';

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(private readonly logger: AgentLogger) {}

  private async attachTeXCount(
    files: string[],
    toolState: AgentWorkspaceState,
    cfg: ToolConfig,
  ): Promise<void> {
    if (cfg.attachTeXCount && files.length > 0) {
      toolState.document.texcountStats = await getTeXCountStats(files);
    }
  }

  /**
   * Compile LaTeX files to PDF and add them to the tool state.
   */
  private async compilePdfs(
    files: string[],
    toolState: AgentWorkspaceState,
  ): Promise<void> {
    const activeGroupId = this.logger.withCurrentGroup((id) => id);
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
                  activeGroupId,
                );
                return undefined;
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
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
        toolState.media.addMediaFiles([result.value]);
      }
    });
  }

  private async extractFiguresFromFiles(
    files: string[],
    toolState: AgentWorkspaceState,
  ): Promise<void> {
    const activeGroupId = this.logger.withCurrentGroup((id) => id);
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
          activeGroupId,
        );
        toolState.media.addMediaFiles(result.value);
      }
    });
  }

  private async compileTikzFigures(
    files: string[],
    toolState: AgentWorkspaceState,
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
        toolState.media.addMediaFiles(result.value);
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
    toolState: AgentWorkspaceState,
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
      toolState.media.addMediaFiles(extraMediaFiles);
    }

    if (includeFigureExtraction && cfg.autoExtractFigure) {
      await this.extractFiguresFromFiles(existingFiles, toolState);
    }

    if (includeTikzCompilation && cfg.autoExtractTikzFigure) {
      await this.compileTikzFigures(existingFiles, toolState, logTikzSummary);
    }

    if (includePdfCompilation && cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, toolState);
    }
  }

  /**
   * Process input files to extract figures, compile TikZ pictures and PDFs.
   * Adds resulting media paths to the provided AgentWorkspaceState.
   */
  async processInputFiles(
    inputFiles: string[],
    toolState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
    extraMediaFiles: string[] = [],
  ): Promise<void> {
    await this.processFiles(inputFiles, toolState, cfg, supportsVision, {
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
    toolState: AgentWorkspaceState,
    cfg: ToolConfig,
    supportsVision: boolean,
  ): Promise<void> {
    await this.processFiles(outputFiles, toolState, cfg, supportsVision, {
      includeFigureExtraction: false,
      includeTikzCompilation: true,
      includePdfCompilation: true,
    });
  }
}
