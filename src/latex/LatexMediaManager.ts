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
import { ToolState } from '@agent/core/ToolState';
import { ToolConfig } from '@agent/core/ToolConfig';
import { WorkspaceFS } from '@utils/files';

/**
 * Handles LaTeX related media extraction and compilation for agents.
 */
export class LatexMediaManager {
  constructor(private readonly logger: AgentLogger) {}

  private async attachTeXCount(
    files: string[],
    toolState: ToolState,
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
    toolState: ToolState,
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

  /**
   * Process input files to extract figures, compile TikZ pictures and PDFs.
   * Adds resulting media paths to the provided ToolState.
   */
  async processInputFiles(
    inputFiles: string[],
    toolState: ToolState,
    cfg: ToolConfig,
    supportsVision: boolean,
    extraMediaFiles: string[] = [],
    groupId?: string,
  ): Promise<void> {
    if (!inputFiles || inputFiles.length === 0) {
      return;
    }

    const existingFilesInfo = await Promise.all(
      inputFiles.map(async (file) => ({
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

    if (cfg.autoExtractFigure) {
      const figureResults = await Promise.allSettled(
        existingFiles.map((file) => extractFigurePathsFromLatex(file)),
      );
      figureResults.forEach((result, idx) => {
        if (
          result.status === 'fulfilled' &&
          result.value &&
          result.value.length > 0
        ) {
          const file = existingFiles[idx];
          this.logger.debug(
            `Extracted ${result.value.length} figures from ${file}`,
            groupId,
          );
          toolState.addMediaFiles(result.value);
        }
      });
    }

    if (cfg.autoExtractTikzFigure) {
      const tikzResults = await Promise.allSettled(
        existingFiles.map((file) => tikzPictureManager.compile(file)),
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
      this.logger.debug(
        `Extracted ${tikzResults.length} TikZ figures`,
        groupId,
      );
    }

    if (cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, toolState, groupId);
    }
  }

  /**
   * Process output files to compile TikZ pictures and PDFs, attach texcount.
   */
  async processOutputFiles(
    outputFiles: string[],
    toolState: ToolState,
    cfg: ToolConfig,
    supportsVision: boolean,
    groupId?: string,
  ): Promise<void> {
    if (!outputFiles || outputFiles.length === 0) {
      return;
    }

    const existingFilesInfo = await Promise.all(
      outputFiles.map(async (file) => ({
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

    if (supportsVision && cfg.autoExtractTikzFigure) {
      const tikzResults = await Promise.allSettled(
        existingFiles.map((file) => tikzPictureManager.compile(file)),
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
    }

    if (supportsVision && cfg.autoCompileInputPdf) {
      await this.compilePdfs(existingFiles, toolState, groupId);
    }
  }
}
